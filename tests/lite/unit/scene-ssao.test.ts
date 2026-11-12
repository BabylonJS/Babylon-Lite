import { describe, expect, it, vi } from "vitest";

import { createRenderTarget } from "../../../packages/babylon-lite/src/engine/render-target";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { Camera } from "../../../packages/babylon-lite/src/camera/camera";
import type { RenderTask } from "../../../packages/babylon-lite/src/frame-graph/render-task";
import { attachSceneSsaoPipeline, createSceneSsaoPipeline, detachSceneSsaoPipeline, disposeSceneSsaoPipeline } from "../../../packages/babylon-lite/src/post-process/scene-ssao";

function makeFixture(msaaSamples: number) {
    const scRT = createRenderTarget({ lbl: "swapchain", format: "bgra8unorm", samples: 1, size: { width: 64, height: 64 } });
    const surface = { msaaSamples, format: "bgra8unorm", scRT, _renderingContexts: [] };
    const engine = {
        ...surface,
        _device: {
            createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
        },
    } as unknown as EngineContext;
    const camera = { viewport: null } as unknown as Camera;
    const defaultTask = {
        name: "scene",
        engine,
        scene: null,
        executionEnabled: true,
        _passes: [],
        _config: { name: "scene", rt: scRT, clr: true },
        _colorAttachment: {},
        record: vi.fn(),
        dispose: vi.fn(),
    } as unknown as RenderTask;
    const tasks = [defaultTask];
    const scene = {
        surface,
        camera,
        _beforeRender: [],
        _frameGraph: { _tasks: tasks },
    } as unknown as SceneContext;
    return { engine, scene, camera, defaultTask, tasks, scRT };
}

describe("createSceneSsaoPipeline", () => {
    it("attaches a single-sample replacement chain and restores the default task", () => {
        const { engine, scene, camera, defaultTask, tasks } = makeFixture(1);
        const pipeline = createSceneSsaoPipeline({ name: "ssao", radius: 3, intensity: 2, base: 0.25, fadeEnd: 40 }, engine, scene, camera);

        attachSceneSsaoPipeline(pipeline);

        expect(tasks.map((task) => task.name)).toEqual(["scene", "ssao-scene", "ssao"]);
        expect(defaultTask.executionEnabled).toBe(false);
        expect(tasks[2]).toMatchObject({ radius: 3, intensity: 2, base: 0.25, fadeStart: 30, fadeEnd: 40, executionEnabled: true });

        pipeline.radius = 4;
        pipeline.intensity = 1.5;
        pipeline.base = 0.5;
        pipeline.fadeEnd = 20;
        scene._beforeRender[0]!(16);
        expect(tasks[2]).toMatchObject({ radius: 4, intensity: 1.5, base: 0.5, fadeStart: 15, fadeEnd: 20 });

        detachSceneSsaoPipeline(pipeline);
        expect(tasks).toEqual([defaultTask]);
        expect(defaultTask.executionEnabled).toBe(true);
        expect(scene._beforeRender).toHaveLength(0);
    });

    it("creates MSAA color/depth resolve tasks and exposes the active resolver", () => {
        const { engine, scene, camera, tasks, scRT } = makeFixture(4);
        const pipeline = createSceneSsaoPipeline({ name: "ssao" }, engine, scene, camera);

        attachSceneSsaoPipeline(pipeline);

        expect(tasks.map((task) => task.name)).toEqual(["scene", "ssao-scene", "ssao-depth-resolve", "ssao"]);
        const output = tasks[3]!._getOutputInfo?.();
        expect(output?.resolveTexture).toBe(scRT);
        expect(output?.colorTexture._descriptor.samples).toBe(4);

        disposeSceneSsaoPipeline(pipeline);
        expect(tasks.map((task) => task.name)).toEqual(["scene"]);
    });

    it("pauses the owned chain while another camera is active", () => {
        const { engine, scene, camera, defaultTask, tasks } = makeFixture(1);
        const pipeline = createSceneSsaoPipeline({}, engine, scene, camera);
        attachSceneSsaoPipeline(pipeline);

        scene.camera = {} as Camera;
        scene._beforeRender[0]!(16);

        expect(defaultTask.executionEnabled).toBe(true);
        expect(tasks.slice(1).every((task) => task.executionEnabled === false)).toBe(true);

        pipeline.camera = scene.camera;
        scene._beforeRender[0]!(16);
        expect(tasks[2]).toMatchObject({ camera: scene.camera, executionEnabled: true });
    });
});
