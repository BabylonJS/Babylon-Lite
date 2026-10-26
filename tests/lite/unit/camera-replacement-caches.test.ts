import { describe, expect, it, vi } from "vitest";

import { _cameraChangeKey, type Camera } from "../../../packages/babylon-lite/src/camera/camera";
import { createFreeCamera } from "../../../packages/babylon-lite/src/camera/free-camera";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { applyLightFoOffset, lightFoVersion, wrapRenderableForFO } from "../../../packages/babylon-lite/src/large-world/floating-origin";
import { createDirectionalLight } from "../../../packages/babylon-lite/src/light/directional-light";
import { createPointLight } from "../../../packages/babylon-lite/src/light/point-light";
import { refreshSceneLightsUBO } from "../../../packages/babylon-lite/src/render/lights-ubo";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { _createCascadeScratch, renderCsmShadowMap, type CsmConfig, type CsmTaskState } from "../../../packages/babylon-lite/src/shadow/csm-shadow-task-hooks";
import { renderPcfShadowMap, type PcfLightMatrix, type PcfTaskState } from "../../../packages/babylon-lite/src/shadow/pcf-shadow-task-hooks";
import type { ShadowGenerator } from "../../../packages/babylon-lite/src/shadow/shadow-generator";

/** Two untouched cameras at different positions that report the SAME transform version and change
 *  key: the replacement `addToScene(scene, camera)` (or `scene.camera = camera`) can install after
 *  the first frame. Caches keyed only on those numbers cannot see the swap. */
function equalVersionCameras(): [Camera, Camera] {
    const a = createFreeCamera({ x: 100, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    const b = createFreeCamera({ x: -250, y: 40, z: 75 }, { x: 0, y: 0, z: 0 });
    expect(b.worldMatrixVersion).toBe(a.worldMatrixVersion);
    expect(_cameraChangeKey(b)).toBe(_cameraChangeKey(a));
    expect(b.worldMatrix[12]).not.toBe(a.worldMatrix[12]);
    return [a, b];
}

describe("camera replacement after the first frame", () => {
    it("floating origin re-packs mesh buffers for an equal-version replacement camera", () => {
        const [a, b] = equalVersionCameras();
        const scene = { camera: a } as unknown as SceneContext;
        const invalidate = vi.fn();
        const update = wrapRenderableForFO(() => {}, scene, invalidate);

        update();
        update();
        expect(invalidate).toHaveBeenCalledTimes(1);

        scene.camera = b;
        update();
        expect(invalidate).toHaveBeenCalledTimes(2);
        update();
        expect(invalidate).toHaveBeenCalledTimes(2);
    });

    it("floating origin re-uploads positional lights relative to an equal-version replacement camera", () => {
        const [a, b] = equalVersionCameras();
        const writeBuffer = vi.fn();
        const engine = {
            _device: { createBuffer: vi.fn(() => ({ destroy: vi.fn() })), queue: { writeBuffer } },
            _lightFoVersion: lightFoVersion,
            _applyLightFoOffset: applyLightFoOffset,
        } as unknown as EngineContext;
        const light = createPointLight([10, 20, 30]);
        const scene = { camera: a, lights: [light], _disposables: [] } as unknown as SceneContext;

        refreshSceneLightsUBO(engine, scene);
        refreshSceneLightsUBO(engine, scene);
        const data = scene._lightGpuState!._scratch;
        expect(data[4]).toBeCloseTo(10 - a.worldMatrix[12]!);
        writeBuffer.mockClear();

        scene.camera = b;
        refreshSceneLightsUBO(engine, scene);
        expect(writeBuffer).toHaveBeenCalledTimes(1);
        expect(data[4]).toBeCloseTo(10 - b.worldMatrix[12]!);
        expect(data[5]).toBeCloseTo(20 - b.worldMatrix[13]!);
        expect(data[6]).toBeCloseTo(30 - b.worldMatrix[14]!);

        refreshSceneLightsUBO(engine, scene);
        expect(writeBuffer).toHaveBeenCalledTimes(1);
    });

    it("floating origin re-renders a cached shadow map relative to an equal-version replacement camera", () => {
        const [a, b] = equalVersionCameras();
        const engine = { _device: { queue: { writeBuffer: vi.fn() } }, useFloatingOrigin: true } as unknown as EngineContext;
        const execute = vi.fn(() => 1);
        const scene = { camera: a } as unknown as SceneContext;
        const state = {
            _task: { record: vi.fn(), execute, dispose: vi.fn() } as unknown as PcfTaskState["_task"],
            _camera: createFreeCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }),
            _lastCasterVersion: -1,
            _lastLightVersion: -1,
            _lastFoVersion: -1,
            _shadowUboData: new Float32Array(24),
            _casterMeshes: [],
            _casterMaterials: [],
            _casterMatGens: [],
            _casterMeshGens: [],
            _scene: scene,
        } satisfies PcfTaskState;
        const sg = {
            _light: { lightType: "spot", worldMatrixVersion: 1, _lightVersion: 1 },
            _lightMatrix: new Float32Array(16),
            _depthValues: new Float32Array(4),
            _shadowsInfo: new Float32Array(4),
            _shadowUBO: {} as GPUBuffer,
            _version: 0,
            _config: { _mapSize: 1024, _bias: 0, _forceRefreshEveryFrame: false },
        } as unknown as ShadowGenerator;
        const matrix: PcfLightMatrix = { _view: new Float32Array(16), _viewProj: new Float32Array(16), _near: 0.1, _far: 10 };
        const computeLightMatrix = vi.fn((_casters: unknown, _x: number, _y: number, _z: number) => matrix);

        expect(renderPcfShadowMap(engine, sg, state, computeLightMatrix)).toBe(1);
        expect(renderPcfShadowMap(engine, sg, state, computeLightMatrix)).toBe(0);

        scene.camera = b;
        const version = sg._version;
        expect(renderPcfShadowMap(engine, sg, state, computeLightMatrix)).toBe(1);
        expect(computeLightMatrix).toHaveBeenLastCalledWith([], b.worldMatrix[12], b.worldMatrix[13], b.worldMatrix[14]);
        expect(sg._version).toBe(version + 1);
        expect(renderPcfShadowMap(engine, sg, state, computeLightMatrix)).toBe(0);
    });

    it("CSM refits cascades to an equal-version replacement camera", () => {
        const [a, b] = equalVersionCameras();
        const writeBuffer = vi.fn();
        const engine = { _device: { queue: { writeBuffer } } } as unknown as EngineContext;
        const execute = vi.fn(() => 1);
        const scene = { camera: a, surface: { scRT: { _width: 16, _height: 9 } } } as unknown as SceneContext;
        const cfg = {
            _numCascades: 2,
            _lambda: 0.5,
            _cascadeBlendPercentage: 0.1,
            _stabilizeCascades: false,
            _shadowMaxZ: 200,
            _bias: 0,
            _worldSpaceBias: null,
            _darkness: 0,
            _frustumEdgeFalloff: 0,
            _mapSize: 64,
            _forceRefreshEveryFrame: false,
        } as unknown as CsmConfig;
        const state = {
            _task: { execute },
            _cameras: [createFreeCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }), createFreeCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 })],
            _scene: scene,
            _lastCasterVersion: -1,
            _lastLightVersion: -1,
            _lastCamVersion: -1,
            _lastCamAspect: -1,
            _uboData: new Float32Array(80),
            _casterMeshes: [],
            _cascadeScratch: _createCascadeScratch(2),
        } as unknown as CsmTaskState;
        const sg = { _light: createDirectionalLight([0, -1, 0.2]), _shadowUBO: {}, _version: 0 } as unknown as ShadowGenerator;

        expect(renderCsmShadowMap(engine, sg, state, cfg)).toBe(1);
        expect(renderCsmShadowMap(engine, sg, state, cfg)).toBe(0);
        const fitToA = (writeBuffer.mock.lastCall![2] as Float32Array).slice();

        scene.camera = b;
        expect(renderCsmShadowMap(engine, sg, state, cfg)).toBe(1);
        expect(Array.from(writeBuffer.mock.lastCall![2] as Float32Array)).not.toEqual(Array.from(fitToA));
        expect(renderCsmShadowMap(engine, sg, state, cfg)).toBe(0);
    });
});
