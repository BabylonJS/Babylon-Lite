import { describe, expect, it, vi } from "vitest";

import { buildRenderTarget, createRenderTarget } from "../../../packages/babylon-lite/src/engine/render-target";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { Camera } from "../../../packages/babylon-lite/src/camera/camera";
import type { RenderTask } from "../../../packages/babylon-lite/src/frame-graph/render-task";
import { createFrameGraph } from "../../../packages/babylon-lite/src/frame-graph/frame-graph";
import { enableSceneTransmission } from "../../../packages/babylon-lite/src/frame-graph/transmission";
import type { ImageProcessingSource } from "../../../packages/babylon-lite/src/frame-graph/image-processing-task";
import type { Task } from "../../../packages/babylon-lite/src/frame-graph/task";
import { attachSceneSsaoPipeline, createSceneSsaoPipeline, detachSceneSsaoPipeline, disposeSceneSsaoPipeline } from "../../../packages/babylon-lite/src/post-process/scene-ssao";

function makeFixture(msaaSamples: number) {
    const scRT = createRenderTarget({ lbl: "swapchain", format: "bgra8unorm", samples: 1, size: { width: 64, height: 64 } });
    const surface = { canvas: { width: 64, height: 64 }, msaaSamples, format: "bgra8unorm", scRT, _renderingContexts: [] };
    const createTexture = (descriptor: GPUTextureDescriptor): GPUTexture => {
        const texture = {
            descriptor,
            format: descriptor.format,
            sampleCount: descriptor.sampleCount ?? 1,
            createView: vi.fn(() => ({ texture }) as unknown as GPUTextureView),
            destroy: vi.fn(),
        };
        return texture as unknown as GPUTexture;
    };
    const engine = {
        ...surface,
        format: surface.format,
        _device: {
            createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
            createTexture: vi.fn(createTexture),
            createBindGroupLayout: vi.fn((descriptor) => descriptor),
            createBindGroup: vi.fn((descriptor) => descriptor),
            createPipelineLayout: vi.fn((descriptor) => descriptor),
            createRenderPipeline: vi.fn((descriptor) => descriptor),
            createShaderModule: vi.fn((descriptor) => descriptor),
            createSampler: vi.fn((descriptor) => descriptor),
            queue: { writeBuffer: vi.fn() },
        },
    } as unknown as EngineContext;
    const camera = { viewport: null } as unknown as Camera;
    const frameGraph = createFrameGraph(engine);
    const sceneTarget =
        msaaSamples > 1 ? createRenderTarget({ lbl: "scene", format: "bgra8unorm", dFormat: "depth24plus-stencil8", samples: msaaSamples, size: { width: 64, height: 64 } }) : scRT;
    const sceneDepth = msaaSamples > 1 ? undefined : createRenderTarget({ lbl: "scene-depth", dFormat: "depth24plus-stencil8", samples: 1, size: { width: 64, height: 64 } });
    const defaultTask = {
        name: "scene",
        engine,
        scene: null,
        executionEnabled: true,
        _passes: [],
        _config: { name: "scene", rt: sceneTarget, rst: msaaSamples > 1 ? scRT : undefined, depth: sceneDepth, clr: true },
        _colorAttachment: {},
        _renderables: [],
        _targetSignature: { _sampleCount: msaaSamples },
        _ownsTargets: true,
        _ob: [],
        _lastVersion: -1,
        record: vi.fn(),
        execute: vi.fn(() => 0),
        dispose: vi.fn(),
    } as unknown as RenderTask;
    const defaultRecord = vi.fn(() => {
        buildRenderTarget(defaultTask._config.rt, engine);
        if (defaultTask._config.rst) {
            buildRenderTarget(defaultTask._config.rst, engine);
        }
        if (defaultTask._config.depth) {
            buildRenderTarget(defaultTask._config.depth, engine);
        }
        defaultTask._colorAttachment.view = defaultTask._config.rt._colorView!;
    });
    defaultTask.record = defaultRecord;
    const tasks = frameGraph._tasks;
    tasks.push(defaultTask);
    const scene = {
        surface,
        camera,
        _beforeRender: [],
        _disposables: [],
        _frameGraph: frameGraph,
        meshes: [],
        imageProcessing: { exposure: 1, contrast: 1, toneMappingEnabled: false },
        clearColor: { r: 0, g: 0, b: 0, a: 1 },
    } as unknown as SceneContext;
    (defaultTask as unknown as { scene: SceneContext }).scene = scene;
    return { engine, scene, camera, defaultTask, defaultRecord, tasks, scRT };
}

function buildRegisteredScene(scene: SceneContext): void {
    scene.surface._renderingContexts.push(scene);
    scene._frameGraph.build();
}

describe("createSceneSsaoPipeline", () => {
    it("attaches a single-sample composite chain and restores the default task", () => {
        const { engine, scene, camera, defaultTask, tasks } = makeFixture(1);
        const pipeline = createSceneSsaoPipeline({ name: "ssao", radius: 3, intensity: 2, base: 0.25, fadeEnd: 40 }, engine, scene, camera);

        attachSceneSsaoPipeline(pipeline);

        expect(tasks.map((task) => task.name)).toEqual(["scene", "ssao"]);
        expect(defaultTask._config.rt).not.toBe(scene.surface.scRT);
        expect(tasks[1]).toMatchObject({ radius: 3, intensity: 2, base: 0.25, fadeStart: 30, fadeEnd: 40, executionEnabled: true });

        pipeline.radius = 4;
        pipeline.intensity = 1.5;
        pipeline.base = 0.5;
        pipeline.fadeEnd = 20;
        scene._beforeRender[0]!(16);
        expect(tasks[1]).toMatchObject({ radius: 4, intensity: 1.5, base: 0.5, fadeStart: 15, fadeEnd: 20 });

        detachSceneSsaoPipeline(pipeline);
        expect(tasks).toEqual([defaultTask]);
        expect(defaultTask.executionEnabled).toBe(true);
        expect(scene._beforeRender).toHaveLength(0);
        expect(scene._disposables).toHaveLength(0);
    });

    it("creates MSAA color/depth resolve tasks and exposes the active resolver", () => {
        const { engine, scene, camera, tasks, scRT } = makeFixture(4);
        const pipeline = createSceneSsaoPipeline({ name: "ssao" }, engine, scene, camera);

        attachSceneSsaoPipeline(pipeline);

        expect(tasks.map((task) => task.name)).toEqual(["scene", "ssao-depth-resolve", "ssao"]);
        const output = tasks[2]!._getOutputInfo?.();
        expect(output?.resolveTexture).toBe(scRT);
        expect(output?.colorTexture._descriptor.samples).toBe(4);

        disposeSceneSsaoPipeline(pipeline);
        expect(tasks.map((task) => task.name)).toEqual(["scene"]);
    });

    it("pauses the owned chain while another camera is active", () => {
        const { engine, scene, camera, defaultTask, tasks } = makeFixture(1);
        const pipeline = createSceneSsaoPipeline({}, engine, scene, camera);
        const nextCamera = {} as Camera;
        scene._beforeRender.push(() => {
            scene.camera = nextCamera;
        });
        attachSceneSsaoPipeline(pipeline);

        for (const callback of scene._beforeRender) {
            callback(16);
        }

        expect(defaultTask.executionEnabled).toBe(true);
        expect(tasks[1]).toMatchObject({ enabled: false, executionEnabled: true });

        pipeline.camera = nextCamera;
        for (const callback of scene._beforeRender) {
            callback(16);
        }
        expect(tasks[1]).toMatchObject({ camera: scene.camera, enabled: true, executionEnabled: true });
    });

    it("skips MSAA depth resolve while another camera is active", () => {
        const { engine, scene, camera, tasks } = makeFixture(4);
        const pipeline = createSceneSsaoPipeline({}, engine, scene, camera);
        const nextCamera = {} as Camera;
        attachSceneSsaoPipeline(pipeline);

        scene.camera = nextCamera;
        scene._beforeRender[0]!(16);

        expect(tasks[1]).toMatchObject({ name: "scene-ssao-depth-resolve", executionEnabled: false });
        expect(tasks[2]).toMatchObject({ enabled: false, executionEnabled: true });

        scene.camera = camera;
        scene._beforeRender[0]!(16);

        expect(tasks[1]).toMatchObject({ executionEnabled: true });
        expect(tasks[2]).toMatchObject({ enabled: true, executionEnabled: true });
    });

    it("releases its scene-owned state when the scene is disposed", () => {
        const { engine, scene, camera } = makeFixture(4);
        const pipeline = createSceneSsaoPipeline({}, engine, scene, camera);
        attachSceneSsaoPipeline(pipeline);

        expect(scene._disposables).toHaveLength(1);
        scene._disposables[0]!();

        expect(pipeline.attached).toBe(false);
        expect(scene._beforeRender).toHaveLength(0);
        expect(() => attachSceneSsaoPipeline(pipeline)).toThrow("has been disposed");
    });

    it("re-records the AO task when resolutionScale changes on a live scene", () => {
        const { engine, scene, camera, tasks } = makeFixture(1);
        const pipeline = createSceneSsaoPipeline({}, engine, scene, camera);
        attachSceneSsaoPipeline(pipeline);
        const ao = tasks[1]!;
        const record = vi.spyOn(ao, "record").mockImplementation(() => {});
        scene.surface._renderingContexts.push(scene);

        pipeline.resolutionScale = 0.75;
        scene._beforeRender[0]!(16);

        expect(record).toHaveBeenCalledOnce();
        expect(ao).toMatchObject({ resolutionScale: 0.75 });
    });

    it.each([1, 4])("composes with transmission when SSAO attaches first at %ix MSAA", (samples) => {
        const { engine, scene, camera, tasks, defaultTask } = makeFixture(samples);
        const pipeline = createSceneSsaoPipeline({}, engine, scene, camera);
        attachSceneSsaoPipeline(pipeline);

        enableSceneTransmission(scene, engine);

        expect(tasks.map((task) => task.name)).toEqual(
            samples > 1 ? ["scene", "scene-ssao-depth-resolve", "scene-ssao", "transmission-image-processing"] : ["scene", "scene-ssao", "transmission-image-processing"]
        );
        expect(defaultTask._config.rt._descriptor.format).toBe("rgba16float");
        expect(scene._outputTexture).toBe(tasks[samples > 1 ? 2 : 1]!._getOutputInfo?.()?.colorTexture);
        const imageProcessing = tasks.at(-1) as unknown as Task & { _source: ImageProcessingSource };
        expect(imageProcessing._source).toBeTypeOf("function");
        expect((imageProcessing._source as () => unknown)()).toBe(scene._outputTexture);
    });

    it.each([1, 4])("composes with transmission when SSAO attaches second at %ix MSAA", (samples) => {
        const { engine, scene, camera, tasks, defaultTask } = makeFixture(samples);
        enableSceneTransmission(scene, engine);
        const pipeline = createSceneSsaoPipeline({}, engine, scene, camera);

        attachSceneSsaoPipeline(pipeline);

        expect(tasks.map((task) => task.name)).toEqual(
            samples > 1 ? ["scene", "scene-ssao-depth-resolve", "scene-ssao", "transmission-image-processing"] : ["scene", "scene-ssao", "transmission-image-processing"]
        );
        expect(defaultTask._config.rt._descriptor.format).toBe("rgba16float");
        expect(scene._outputTexture).toBe(tasks[samples > 1 ? 2 : 1]!._getOutputInfo?.()?.colorTexture);
        const imageProcessing = tasks.at(-1) as unknown as Task & { _source: ImageProcessingSource };
        expect((imageProcessing._source as () => unknown)()).toBe(scene._outputTexture);
    });

    it.each([1, 4])("rebuilds live transmission producers and consumers when SSAO attaches second at %ix MSAA", (samples) => {
        const { engine, scene, camera, defaultTask, defaultRecord } = makeFixture(samples);
        enableSceneTransmission(scene, engine);
        buildRegisteredScene(scene);
        const pipeline = createSceneSsaoPipeline({}, engine, scene, camera);
        const builtBeforeAttach = defaultRecord.mock.calls.length;

        expect(() => attachSceneSsaoPipeline(pipeline)).not.toThrow();
        expect(defaultRecord).toHaveBeenCalledTimes(builtBeforeAttach + 1);
        expect(defaultTask._config.rt._colorTexture).not.toBeNull();
        expect(scene._outputTexture?._colorTexture).not.toBeNull();

        expect(() => detachSceneSsaoPipeline(pipeline)).not.toThrow();
        expect(defaultRecord).toHaveBeenCalledTimes(builtBeforeAttach + 2);
        expect(defaultTask._config.rt._colorTexture).not.toBeNull();
    });

    it.each([1, 4])("rebuilds live transmission producers and consumers when SSAO attaches first at %ix MSAA", (samples) => {
        const { engine, scene, camera, defaultTask, defaultRecord } = makeFixture(samples);
        const pipeline = createSceneSsaoPipeline({}, engine, scene, camera);
        attachSceneSsaoPipeline(pipeline);
        buildRegisteredScene(scene);
        const builtBeforeTransmission = defaultRecord.mock.calls.length;

        expect(() => enableSceneTransmission(scene, engine)).not.toThrow();
        expect(defaultRecord).toHaveBeenCalledTimes(builtBeforeTransmission + 2);
        expect(defaultTask._config.rt._colorTexture).not.toBeNull();
        expect(scene._outputTexture?._colorTexture).not.toBeNull();

        expect(() => detachSceneSsaoPipeline(pipeline)).not.toThrow();
        expect(defaultRecord).toHaveBeenCalledTimes(builtBeforeTransmission + 3);
        expect(defaultTask._config.rt._colorTexture).not.toBeNull();
    });

    it("releases a displaced task-owned transmission target on scene disposal", () => {
        const { engine, scene, camera, defaultTask } = makeFixture(1);
        enableSceneTransmission(scene, engine);
        const transmissionTarget = defaultTask._config.rt;
        const destroy = vi.fn();
        transmissionTarget._colorTexture = { destroy } as unknown as GPUTexture;
        const pipeline = createSceneSsaoPipeline({}, engine, scene, camera);
        attachSceneSsaoPipeline(pipeline);

        scene._disposables[0]!();

        expect(destroy).toHaveBeenCalledOnce();
        expect(transmissionTarget._colorTexture).toBeNull();
    });
});
