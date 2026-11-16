/**
 * An installed camera's floating-origin mode must match its destination engine before rendering.
 *
 * `getViewMatrix` zeroes the view translation only when `camera._useFloatingOrigin` is set, while
 * floating-origin meshes are packed relative to the active camera whenever the engine has FO on.
 * A mismatch draws every mesh offset by the camera translation (twice, or not at all). These cases
 * drive the real scene `_update`, `addToScene`/`removeFromScene` and `_writePassSceneUBO`, then read
 * the uploaded view translation (SceneUniforms `view` at float 16 → translation at 28..30).
 */
import { describe, expect, it } from "vitest";

import { createFreeCamera } from "../../../packages/babylon-lite/src/camera/free-camera";
import { getViewMatrix, getViewProjectionMatrix, type Camera } from "../../../packages/babylon-lite/src/camera/camera";
import { getFloatingOriginOffset } from "../../../packages/babylon-lite/src/large-world/floating-origin";
import { _writePassSceneUBO, type RenderTask } from "../../../packages/babylon-lite/src/frame-graph/render-task";
import { createSceneContext } from "../../../packages/babylon-lite/src/scene/scene";
import { addToScene, onBeforeRender, type SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { removeFromScene } from "../../../packages/babylon-lite/src/scene/scene-remove";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { RenderTarget } from "../../../packages/babylon-lite/src/engine/render-target";

const gpuGlobals = globalThis as Omit<typeof globalThis, "GPUBufferUsage"> & { GPUBufferUsage?: { UNIFORM: number; COPY_DST: number } };
gpuGlobals.GPUBufferUsage ??= { UNIFORM: 0x40, COPY_DST: 0x8 } as unknown as GPUBufferUsage;

const FAR = 100_000;

function makeEngine(useFloatingOrigin: boolean): { engine: EngineContext; uploads: Float32Array[] } {
    const uploads: Float32Array[] = [];
    const device = {
        createBuffer: (descriptor: GPUBufferDescriptor) => ({ descriptor, destroy: () => undefined }) as unknown as GPUBuffer,
        createBindGroupLayout: (d: GPUBindGroupLayoutDescriptor) => d as unknown as GPUBindGroupLayout,
        createBindGroup: (d: GPUBindGroupDescriptor) => d as unknown as GPUBindGroup,
        queue: {
            writeBuffer: (_buffer: GPUBuffer, _offset: number, data: Float32Array) => {
                uploads.push(data.slice());
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
    const engine = {
        canvas: { width: 800, height: 600 } as HTMLCanvasElement,
        msaaSamples: 1,
        useFloatingOrigin,
        useHighPrecisionMatrix: true,
        format: "bgra8unorm",
        _device: device,
        _currentDelta: 16,
        _currentEncoder: {} as GPUCommandEncoder,
        _renderingContexts: [],
        scRT,
    } as unknown as EngineContext;
    Object.assign(engine, { engine, surfaces: [engine], _surfaces: [engine] });
    return { engine, uploads };
}

function makeScene(useFloatingOrigin: boolean) {
    const { engine, uploads } = makeEngine(useFloatingOrigin);
    const scene = createSceneContext(engine) as SceneContext;
    const task = scene._frameGraph._tasks.find((t): t is RenderTask => t._sceneUboCacheKey !== undefined)!;
    /** One frame: `_update` (callbacks + FO sync), then the forward pass's scene-UBO write. */
    const frame = (): void => {
        scene._update();
        _writePassSceneUBO(task, engine, scene, scene.camera);
    };
    /** View translation of the most recently uploaded scene UBO. */
    const viewTranslation = (): number[] => Array.from(uploads.at(-1)!.subarray(28, 31), (v) => v + 0);
    return { scene, frame, uploads, viewTranslation };
}

function farCamera(): Camera {
    return createFreeCamera({ x: FAR, y: 0, z: 0 }, { x: FAR, y: 0, z: 10 });
}

describe("installed camera floating-origin mode", () => {
    it("renders a fresh camera installed from onBeforeRender in floating-origin mode on its first and next frames", () => {
        const { scene, frame, uploads, viewTranslation } = makeScene(true);
        scene.camera = createFreeCamera({ x: 0, y: 0, z: -10 }, { x: 0, y: 0, z: 0 });
        frame();

        const replacement = farCamera();
        let installed = false;
        onBeforeRender(scene, () => {
            if (!installed) {
                installed = true;
                addToScene(scene, replacement);
            }
        });

        uploads.length = 0;
        frame();
        expect(scene.camera).toBe(replacement);
        expect(replacement._useFloatingOrigin).toBe(true);
        expect(uploads).toHaveLength(1);
        expect(viewTranslation()).toEqual([0, 0, 0]);

        frame();
        expect(viewTranslation()).toEqual([0, 0, 0]);
    });

    it("exposes eye-relative matrices to onBeforeRender on an installed camera's first frame", () => {
        const { scene, frame, viewTranslation } = makeScene(true);
        const camera = farCamera();
        addToScene(scene, camera);

        let view: number[] = [];
        let clip: number[] = [];
        onBeforeRender(scene, () => {
            if (view.length) {
                return;
            }
            const v = getViewMatrix(camera);
            view = [v[12]! + 0, v[13]! + 0, v[14]! + 0];
            // A point 10 units ahead of the camera, expressed relative to the floating origin as FO
            // world data is: it must land in the centre of the view.
            const origin = getFloatingOriginOffset(scene);
            const m = getViewProjectionMatrix(camera, 800 / 600);
            const p = [FAR - origin.x, 0 - origin.y, 20 - origin.z];
            const w = m[3]! * p[0]! + m[7]! * p[1]! + m[11]! * p[2]! + m[15]!;
            clip = [(m[0]! * p[0]! + m[4]! * p[1]! + m[8]! * p[2]! + m[12]!) / w, (m[1]! * p[0]! + m[5]! * p[1]! + m[9]! * p[2]! + m[13]!) / w];
        });

        frame();
        expect(view).toEqual([0, 0, 0]);
        expect(clip[0]).toBeCloseTo(0, 6);
        expect(clip[1]).toBeCloseTo(0, 6);
        expect(viewTranslation()).toEqual([0, 0, 0]);
    });

    it("drops floating-origin mode when a camera moves from an FO-on scene to an FO-off scene", () => {
        const source = makeScene(true);
        const destination = makeScene(false);
        const camera = farCamera();
        addToScene(source.scene, camera);
        source.frame();
        expect(camera._useFloatingOrigin).toBe(true);
        expect(source.viewTranslation()).toEqual([0, 0, 0]);

        removeFromScene(source.scene, camera);
        addToScene(destination.scene, camera);
        destination.frame();
        expect(camera._useFloatingOrigin).toBe(false);
        // Absolute view: the camera looks down +Z from x = FAR, so the view translation is -FAR on x.
        expect(destination.viewTranslation()[0]).toBeCloseTo(-FAR, 0);

        destination.frame();
        expect(destination.viewTranslation()[0]).toBeCloseTo(-FAR, 0);
    });

    it("invalidates camera-keyed caches when the mode flips back on an unchanged camera", () => {
        const fo = makeScene(true);
        const plain = makeScene(false);
        const camera = farCamera();
        addToScene(fo.scene, camera);
        fo.frame();
        removeFromScene(fo.scene, camera);
        addToScene(plain.scene, camera);
        plain.frame();
        removeFromScene(plain.scene, camera);
        addToScene(fo.scene, camera);

        fo.uploads.length = 0;
        fo.frame();
        // The camera, its transform and projection are unchanged since this task last wrote, but its
        // view frame changed twice; the change key must move so no consumer can reuse a cross-mode entry.
        expect(fo.uploads).toHaveLength(1);
        expect(fo.viewTranslation()).toEqual([0, 0, 0]);
    });
});
