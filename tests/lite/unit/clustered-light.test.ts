import { describe, expect, it, vi } from "vitest";

import type { Camera } from "../../../packages/babylon-lite/src/camera/camera";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import {
    buildClusteredLightGpuState,
    createClusteredLightContainer,
    createClusteredPointLight,
    markClusteredLightContainerDirty,
} from "../../../packages/babylon-lite/src/light/clustered";
import type { Mat4 } from "../../../packages/babylon-lite/src/math/types";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";

function identity(): Mat4 {
    return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) as unknown as Mat4;
}

function camera(): Camera {
    return {
        nearPlane: 0.1,
        farPlane: 100,
        fov: Math.PI / 3,
        worldMatrix: identity(),
        worldMatrixVersion: 1,
        children: [],
        _viewCache: new Float32Array(16),
        _projCache: new Float32Array(16),
        _vpCache: new Float32Array(16),
    };
}

function setup() {
    const writeBuffer = vi.fn();
    const writeTexture = vi.fn();
    const device = {
        limits: { maxTextureDimension2D: 8192 },
        queue: { writeBuffer, writeTexture },
        createBuffer: vi.fn(() => ({ destroy: vi.fn() }) as unknown as GPUBuffer),
        createTexture: vi.fn(
            () =>
                ({
                    createView: vi.fn(() => ({}) as GPUTextureView),
                    destroy: vi.fn(),
                }) as unknown as GPUTexture
        ),
    } as unknown as GPUDevice;
    const activeCamera = camera();
    const engine = { canvas: { width: 1024, height: 800 }, _device: device } as unknown as EngineContext;
    const scene = { camera: activeCamera } as unknown as SceneContext;
    return { engine, scene, activeCamera, writeBuffer, writeTexture };
}

describe("clustered light uploads", () => {
    it("compacts inactive lights and uploads only the addressed texture region", () => {
        const { engine, scene, writeBuffer, writeTexture } = setup();
        const container = createClusteredLightContainer();
        createClusteredPointLight(container, { position: [0, 1, 5], diffuse: [1, 1, 1], range: 4, intensity: 2 });
        createClusteredPointLight(container, { position: [1, 1, 5], diffuse: [1, 0, 0], range: 4, intensity: 0 });

        buildClusteredLightGpuState(engine, scene, container);

        const params = writeBuffer.mock.calls.at(-1)![2] as Float32Array;
        expect(new Uint32Array(params.buffer, params.byteOffset, params.length)[3]).toBe(1);
        const extents = writeTexture.mock.calls.map((call) => call[3] as GPUExtent3DDict);
        expect(extents).toContainEqual({ width: 2, height: 1 });
        expect(extents).toContainEqual({ width: 16, height: 1 });
        expect(extents).toContainEqual({ width: 4096, height: 1 });
    });

    it("uploads only light data when color changes without moving cluster topology", () => {
        const { engine, scene, activeCamera, writeBuffer, writeTexture } = setup();
        const container = createClusteredLightContainer();
        const light = createClusteredPointLight(container, { position: [0, 1, 5], diffuse: [1, 1, 1], range: 4, intensity: 2 });
        const state = buildClusteredLightGpuState(engine, scene, container);
        writeBuffer.mockClear();
        writeTexture.mockClear();

        light.diffuse[0] = 0.5;
        markClusteredLightContainerDirty(container);
        state.refresh(activeCamera, 1024, 800);

        expect(writeBuffer).not.toHaveBeenCalled();
        expect(writeTexture).toHaveBeenCalledTimes(1);
        expect(writeTexture.mock.calls[0]![3]).toEqual({ width: 2, height: 1 });
    });

    it("rebuilds topology and light count when lights are removed directly", () => {
        const { engine, scene, activeCamera, writeBuffer, writeTexture } = setup();
        const container = createClusteredLightContainer();
        createClusteredPointLight(container, { position: [0, 1, 5], diffuse: [1, 1, 1], range: 4, intensity: 2 });
        createClusteredPointLight(container, { position: [1, 1, 5], diffuse: [1, 0, 0], range: 4, intensity: 2 });
        const state = buildClusteredLightGpuState(engine, scene, container);
        writeBuffer.mockClear();
        writeTexture.mockClear();

        container.pointLights.pop();
        state.refresh(activeCamera, 1024, 800);

        const params = writeBuffer.mock.calls.at(-1)![2] as Float32Array;
        expect(new Uint32Array(params.buffer, params.byteOffset, params.length)[3]).toBe(1);
        expect(writeTexture).toHaveBeenCalled();
    });
});
