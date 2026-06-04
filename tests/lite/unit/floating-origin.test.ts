import { describe, expect, it, beforeAll, afterAll } from "vitest";

import { createFreeCamera } from "../../../packages/babylon-lite/src/camera/free-camera";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { _setHpmAllocator, _resetMatrixAllocatorForTests } from "../../../packages/babylon-lite/src/math/_matrix-allocator";
import { allocateF64Mat4 } from "../../../packages/babylon-lite/src/math/_mat4-storage-f64";
import { getFloatingOriginOffset } from "../../../packages/babylon-lite/src/large-world/floating-origin";
import { createSceneContext } from "../../../packages/babylon-lite/src/scene/scene";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";

const gpuGlobals = globalThis as typeof globalThis & {
    GPUShaderStage?: unknown;
    GPUBufferUsage?: unknown;
    GPUTextureUsage?: unknown;
};

gpuGlobals.GPUShaderStage ??= { VERTEX: 0x1, FRAGMENT: 0x2 } as unknown as GPUShaderStage;
gpuGlobals.GPUBufferUsage ??= { UNIFORM: 0x40, COPY_DST: 0x8 } as unknown as GPUBufferUsage;
gpuGlobals.GPUTextureUsage ??= { RENDER_ATTACHMENT: 0x10, TEXTURE_BINDING: 0x4 } as unknown as GPUTextureUsage;

function makeMockEngine(hpm = false, useFO = false): EngineContext {
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

    // Mirror createEngine's dynamic-import pattern statically for the fake:
    // when useFO is true, hook the real updateFloatingOriginOffset into
    // `_updateFOOffset` so scene._update will call it. When false, leave the
    // field undefined — the FO module is never referenced.
    return {
        canvas: {} as HTMLCanvasElement,
        msaaSamples: 4,
        drawCallCount: 0,
        maxDevicePixelRatio: Infinity,
        useHighPrecisionMatrix: hpm,
        useFloatingOrigin: useFO,
        _device: device,
        _context: {} as GPUCanvasContext,
        format: "bgra8unorm",
        _alphaMode: "opaque",
        _animFrameId: 0,
        _renderFn: null,
        _renderingContexts: [],
        _currentEncoder: {} as GPUCommandEncoder,
        _swapchainView: {} as GPUTextureView,
        _currentDelta: 16.67,
        _cbs: [],
    } as EngineContext;
}

describe("floating origin", () => {
    // Install F64 allocator process-globally — these tests need HPM precision
    // for the camera world matrix to round-trip far-from-origin coordinates.
    beforeAll(() => _setHpmAllocator(allocateF64Mat4));
    afterAll(() => _resetMatrixAllocatorForTests());

    it("getFloatingOriginOffset returns the active camera's world position", () => {
        const engine = makeMockEngine(true, true);
        const scene = createSceneContext(engine) as SceneContext;
        scene.camera = createFreeCamera({ x: 1_000_000.25, y: -2_000_000.5, z: 3_000_000.75 }, { x: 0, y: 0, z: 0 });

        const offset = getFloatingOriginOffset(scene);
        expect(offset.x).toBeCloseTo(1_000_000.25, 6);
        expect(offset.y).toBeCloseTo(-2_000_000.5, 6);
        expect(offset.z).toBeCloseTo(3_000_000.75, 6);
    });

    it("getFloatingOriginOffset returns zero when no camera is set", () => {
        const engine = makeMockEngine(true, true);
        const scene = createSceneContext(engine) as SceneContext;
        // scene.camera intentionally left null.

        const offset = getFloatingOriginOffset(scene);
        expect(offset.x).toBe(0);
        expect(offset.y).toBe(0);
        expect(offset.z).toBe(0);
    });

    it("scene._update sets the camera's _useFloatingOrigin flag when engine has FO on", () => {
        const engine = makeMockEngine(true, true);
        const scene = createSceneContext(engine) as SceneContext;
        const cam = createFreeCamera({ x: 100, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
        scene.camera = cam;

        // Pre-update: camera has no LWR flag.
        expect(cam._useFloatingOrigin).toBeUndefined();

        scene._update();

        // Post-update: scene marks the camera as LWR-aware so `getViewMatrix`
        // zeros the translation column.
        expect(cam._useFloatingOrigin).toBe(true);
    });

    it("scene._update does NOT set the camera's _useFloatingOrigin flag when engine has FO off", () => {
        const engine = makeMockEngine(false, false);
        const scene = createSceneContext(engine) as SceneContext;
        const cam = createFreeCamera({ x: 100, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
        scene.camera = cam;

        scene._update();

        expect(cam._useFloatingOrigin).toBeUndefined();
    });
});
