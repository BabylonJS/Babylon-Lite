import { describe, expect, it } from "vitest";

import { createFreeCamera } from "../../packages/babylon-lite/src/camera/free-camera";
import type { EngineContext, EngineContextInternal } from "../../packages/babylon-lite/src/engine/engine";
import { createF64MatrixAllocator } from "../../packages/babylon-lite/src/math/_mat4-storage-f64";
import { getFloatingOriginOffset } from "../../packages/babylon-lite/src/large-world/floating-origin";
import { createSceneContext } from "../../packages/babylon-lite/src/scene/scene";
import type { SceneContextInternal } from "../../packages/babylon-lite/src/scene/scene-core";

const gpuGlobals = globalThis as typeof globalThis & {
    GPUShaderStage?: { VERTEX: number; FRAGMENT: number };
    GPUBufferUsage?: { UNIFORM: number; COPY_DST: number };
    GPUTextureUsage?: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number };
};

gpuGlobals.GPUShaderStage ??= { VERTEX: 0x1, FRAGMENT: 0x2 };
gpuGlobals.GPUBufferUsage ??= { UNIFORM: 0x40, COPY_DST: 0x8 };
gpuGlobals.GPUTextureUsage ??= { RENDER_ATTACHMENT: 0x10, TEXTURE_BINDING: 0x4 };

function makeMockEngine(hpm = false): EngineContext {
    const device = {
        createBindGroupLayout: (descriptor: GPUBindGroupLayoutDescriptor) => descriptor as unknown as GPUBindGroupLayout,
        createBuffer: (descriptor: GPUBufferDescriptor) => ({ descriptor, destroy: () => undefined }) as unknown as GPUBuffer,
        createBindGroup: (descriptor: GPUBindGroupDescriptor) => descriptor as unknown as GPUBindGroup,
        createTexture: (descriptor: GPUTextureDescriptor) =>
            ({
                descriptor,
                createView: () => ({}) as GPUTextureView,
                destroy: () => undefined,
            }) as unknown as GPUTexture,
        queue: {
            writeBuffer: () => undefined,
        },
    } as unknown as GPUDevice;

    return {
        canvas: {} as HTMLCanvasElement,
        msaaSamples: 4,
        drawCallCount: 0,
        useHighPrecisionMatrix: hpm,
        device,
        context: {} as GPUCanvasContext,
        format: "bgra8unorm",
        alphaMode: "opaque",
        _animFrameId: 0,
        _renderFn: null,
        _renderingContexts: [],
        _currentEncoder: {} as GPUCommandEncoder,
        _swapchainView: {} as GPUTextureView,
        _currentDelta: 16.67,
        _cbs: [],
        _matrixPolicy: hpm ? createF64MatrixAllocator() : { storageKind: "f32" as const, allocate: () => new Float32Array(16) as unknown as never },
    } as EngineContextInternal;
}

describe("floating origin", () => {
    it("tracks camera eye position as floating origin offset when enabled", () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine, { useFloatingOrigin: true }) as SceneContextInternal;
        scene.camera = createFreeCamera(engine, { x: 1_000_000.25, y: -2_000_000.5, z: 3_000_000.75 }, { x: 0, y: 0, z: 0 });

        scene._update();

        const offset = getFloatingOriginOffset(scene);
        expect(offset.x).toBeCloseTo(1_000_000.25, 6);
        expect(offset.y).toBeCloseTo(-2_000_000.5, 6);
        expect(offset.z).toBeCloseTo(3_000_000.75, 6);
    });

    it("keeps floating origin offset at zero when disabled", () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContextInternal;
        scene.camera = createFreeCamera(engine, { x: 1234, y: 5678, z: 9012 }, { x: 0, y: 0, z: 0 });

        scene._update();

        const offset = getFloatingOriginOffset(scene);
        expect(offset.x).toBe(0);
        expect(offset.y).toBe(0);
        expect(offset.z).toBe(0);
    });

    it("scene._update wires the camera's _floatingOriginOffset to the scene's offset array", () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine, { useFloatingOrigin: true }) as SceneContextInternal;
        const cam = createFreeCamera(engine, { x: 100, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
        scene.camera = cam;

        // Pre-wire: camera has no offset reference yet.
        expect(cam._floatingOriginOffset).toBeUndefined();

        scene._update();

        // Post-wire: camera holds a reference to the scene's offset array (same object identity).
        expect(cam._floatingOriginOffset).toBe(scene._floatingOriginOffset);
    });
});
