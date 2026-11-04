/**
 * Runtime writes to `fov` / `nearPlane` / `farPlane` must reach the GPU.
 *
 * These are plain writable fields on a plain-data camera, so a write notifies nobody.
 * `_cameraChangeKey` polls them by value and bumps `_projRev`, which is both the matrix
 * caches' key and the key every projection-dependent per-frame consumer gates on.
 *
 * Two failure modes are covered, and they are independent:
 *  - the matrix getters returning a stale cached matrix, and
 *  - the getters being correct but a consumer never calling them because its own gate
 *    (keyed on the camera version) saw no change. The scene-UBO cases drive the REAL
 *    `_writePassSceneUBO` against a mock device counting `queue.writeBuffer`, so they
 *    fail if the projection revision is dropped from that gate's key set.
 */
import { describe, expect, it } from "vitest";

import { getProjectionMatrix, getViewProjectionMatrix, _cameraChangeKey, type Camera } from "../../../packages/babylon-lite/src/camera/camera";
import { createArcRotateCamera } from "../../../packages/babylon-lite/src/camera/arc-rotate";
import { enableOrthographicCamera } from "../../../packages/babylon-lite/src/camera/orthographic";
import { _writePassSceneUBO, type RenderTask } from "../../../packages/babylon-lite/src/frame-graph/render-task";
import { createSceneContext } from "../../../packages/babylon-lite/src/scene/scene";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { RenderTarget } from "../../../packages/babylon-lite/src/engine/render-target";

const gpuGlobals = globalThis as Omit<typeof globalThis, "GPUBufferUsage"> & { GPUBufferUsage?: { UNIFORM: number; COPY_DST: number } };
gpuGlobals.GPUBufferUsage ??= { UNIFORM: 0x40, COPY_DST: 0x8 } as unknown as GPUBufferUsage;

/** Mock engine whose `queue.writeBuffer` increments `writeCount.n`. Mirrors
 *  `render-task-scene-ubo-guard.test.ts`. */
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

function setup() {
    const writeCount = { n: 0 };
    const engine = makeMockEngine(writeCount);
    const scene = createSceneContext(engine) as SceneContext;
    const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 3, 30, { x: 0, y: 0, z: 0 });
    scene.camera = camera;
    const task = scene._frameGraph._tasks.find((t): t is RenderTask => t._sceneUboCacheKey !== undefined)!;
    writeCount.n = 0;
    const write = () => _writePassSceneUBO(task, engine, scene, camera);
    return { camera: camera as Camera, write, writeCount };
}

const ASPECT = 16 / 9;

describe("projection parameters — matrix caches", () => {
    it("rebuilds the projection when fov changes with the camera at rest", () => {
        const { camera } = setup();
        // m[5] = 1 / tan(fov / 2): strictly decreasing in fov, so it alone identifies the change.
        const before = getProjectionMatrix(camera, ASPECT)[5]!;
        const transformVersion = camera.worldMatrixVersion;

        camera.fov = camera.fov * 2;
        expect(getProjectionMatrix(camera, ASPECT)[5]!).toBeCloseTo(1 / Math.tan(camera.fov / 2), 5);
        expect(getProjectionMatrix(camera, ASPECT)[5]!).toBeLessThan(before);

        // The transform must not be faked as dirty, or the camera's children would be
        // invalidated and floating origin would rebase every renderable.
        expect(camera.worldMatrixVersion).toBe(transformVersion);
    });

    it("rebuilds the projection when nearPlane or farPlane changes", () => {
        const { camera } = setup();
        // Reverse-Z: near maps to 1, far maps to 0, and m[10] / m[14] carry both planes.
        const depthTerms = () => [getProjectionMatrix(camera, ASPECT)[10]!, getProjectionMatrix(camera, ASPECT)[14]!];
        const start = depthTerms();

        camera.nearPlane = camera.nearPlane * 4;
        const afterNear = depthTerms();
        expect(afterNear).not.toEqual(start);

        camera.farPlane = camera.farPlane * 4;
        expect(depthTerms()).not.toEqual(afterNear);
    });

    it("propagates through the view-projection cache", () => {
        const { camera } = setup();
        const before = Array.from(getViewProjectionMatrix(camera, ASPECT) as unknown as Float32Array);

        camera.fov = camera.fov * 1.5;

        expect(Array.from(getViewProjectionMatrix(camera, ASPECT) as unknown as Float32Array)).not.toEqual(before);
    });

    it("does not move the change key when a parameter is rewritten with its current value", () => {
        const { camera } = setup();
        const key = _cameraChangeKey(camera);
        const { fov, nearPlane, farPlane } = camera;

        camera.fov = fov;
        camera.nearPlane = nearPlane;
        camera.farPlane = farPlane;

        expect(_cameraChangeKey(camera)).toBe(key);
    });
});

describe("projection parameters — steady-state scene UBO uploads", () => {
    it("re-uploads when fov changes after steady state", () => {
        const { camera, write, writeCount } = setup();
        write();
        write();
        expect(writeCount.n, "steady state skips the GPU write").toBe(1);

        camera.fov = 0.4;
        write();
        expect(writeCount.n, "a fov change must reach the GPU").toBe(2);

        write();
        expect(writeCount.n, "settles back to steady state").toBe(2);
    });

    it("re-uploads when the depth planes change after steady state", () => {
        const { camera, write, writeCount } = setup();
        write();
        expect(writeCount.n).toBe(1);

        camera.nearPlane = 0.5;
        write();
        expect(writeCount.n, "a near-plane change must reach the GPU").toBe(2);

        camera.farPlane = 5000;
        write();
        expect(writeCount.n, "a far-plane change must reach the GPU").toBe(3);
    });

    it("re-uploads for a depth-plane change under an orthographic camera", () => {
        const { camera, write, writeCount } = setup();
        enableOrthographicCamera(camera, { halfHeight: 6 });
        write();
        write();
        expect(writeCount.n).toBe(1);

        // `fov` is inert in this mode, but the ortho volume still takes its depth range
        // from the camera's planes.
        camera.farPlane = 5000;
        write();
        expect(writeCount.n, "a far-plane change must reach the GPU under ortho too").toBe(2);
    });

    it("does not re-upload when a parameter is rewritten with its current value", () => {
        const { camera, write, writeCount } = setup();
        write();
        expect(writeCount.n).toBe(1);

        const { fov, nearPlane, farPlane } = camera;
        camera.fov = fov;
        camera.nearPlane = nearPlane;
        camera.farPlane = farPlane;
        write();
        expect(writeCount.n).toBe(1);
    });
});
