import { describe, expect, it } from "vitest";

import type { Camera } from "../../../packages/babylon-lite/src/camera/camera";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { RenderTarget } from "../../../packages/babylon-lite/src/engine/render-target";
import { _writePassSceneUBO, type RenderTask } from "../../../packages/babylon-lite/src/frame-graph/render-task";
import type { Mat4 } from "../../../packages/babylon-lite/src/math/types";
import { createSceneContext } from "../../../packages/babylon-lite/src/scene/scene";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { EnvironmentTextures } from "../../../packages/babylon-lite/src/loader-env/load-env";

const gpuGlobals = globalThis as Omit<typeof globalThis, "GPUBufferUsage"> & { GPUBufferUsage?: { UNIFORM: number; COPY_DST: number } };
gpuGlobals.GPUBufferUsage ??= { UNIFORM: 0x40, COPY_DST: 0x8 } as unknown as GPUBufferUsage;

function makeIdentityMatrix(): Mat4 {
    const m = new Float32Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    return m as unknown as Mat4;
}

function makeCamera(): Camera {
    return {
        fov: Math.PI / 4,
        nearPlane: 0.1,
        farPlane: 100,
        children: [],
        worldMatrix: makeIdentityMatrix(),
        worldMatrixVersion: 1,
        _viewCache: new Float32Array(16),
        _projCache: new Float32Array(16),
        _vpCache: new Float32Array(16),
    } as unknown as Camera;
}

/** Mock engine whose queue.writeBuffer increments `writeCount.n` so the test can
 *  observe when the scene UBO is (re-)packed. Single-sample so the default render
 *  task renders straight into scRT. */
function makeMockEngine(writeCount: { n: number }): EngineContext {
    const device = {
        createBuffer: (descriptor: GPUBufferDescriptor) => ({ descriptor, destroy: () => undefined }) as unknown as GPUBuffer,
        createBindGroupLayout: (d: GPUBindGroupLayoutDescriptor) => d as unknown as GPUBindGroupLayout,
        createBindGroup: (d: GPUBindGroupDescriptor) => d as unknown as GPUBindGroup,
        queue: {
            writeBuffer: () => {
                writeCount.n++;
            },
        },
    } as unknown as GPUDevice;

    const scRT = {
        _colorTexture: {},
        _colorView: {},
        _depthTexture: null,
        _depthView: null,
        _descriptor: { format: "bgra8unorm", samples: 1, size: { width: 800, height: 600 } },
        _width: 800,
        _height: 600,
        _eager: true,
    } as unknown as RenderTarget;

    const eng = {
        canvas: { width: 800, height: 600 } as HTMLCanvasElement,
        msaaSamples: 1,
        useFloatingOrigin: false,
        useHighPrecisionMatrix: false,
        format: "bgra8unorm",
        _device: device,
        scRT,
    } as unknown as EngineContext;
    Object.assign(eng, { engine: eng, surfaces: [eng], _surfaces: [eng] });
    return eng;
}

function makeEnvTextures(): EnvironmentTextures {
    return {
        specularCube: {} as GPUTexture,
        sphericalHarmonics: new Float32Array(36).fill(0.5),
        lodGenerationScale: 0.8,
    } as unknown as EnvironmentTextures;
}

describe("writePassSceneUBO scene-UBO change-detection guard", () => {
    it("re-packs the scene UBO when scene._envTextures changes even though camera/exposure are unchanged", () => {
        const writeCount = { n: 0 };
        const engine = makeMockEngine(writeCount);
        const scene = createSceneContext(engine) as SceneContext;
        const camera = makeCamera();
        scene.camera = camera;
        const task = scene._frameGraph._tasks.find((t): t is RenderTask => "_su" in t)!;

        // Scene/task construction may itself issue buffer writes; isolate the guard's own writes.
        writeCount.n = 0;

        // Cold call: nothing cached yet, so the UBO is packed and written once.
        _writePassSceneUBO(task, engine, scene, camera);
        expect(writeCount.n).toBe(1);

        // Nothing changed: the guard bails before touching the GPU.
        _writePassSceneUBO(task, engine, scene, camera);
        expect(writeCount.n).toBe(1);

        // An environment loads AFTER steady state. None of the other guarded inputs
        // (camera/fog/exposure/contrast/envRotationY) changed, so without tracking
        // `_envTextures` the UBO would never be rewritten and the model would keep
        // zero irradiance. The guard must invalidate and re-pack the UBO.
        scene._envTextures = makeEnvTextures();
        _writePassSceneUBO(task, engine, scene, camera);
        expect(writeCount.n).toBe(2);

        // Swapping to a different environment must also re-pack.
        scene._envTextures = makeEnvTextures();
        _writePassSceneUBO(task, engine, scene, camera);
        expect(writeCount.n).toBe(3);
    });
});
