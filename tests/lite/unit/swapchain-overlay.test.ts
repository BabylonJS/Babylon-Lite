import { describe, expect, it } from "vitest";

import type { SurfaceContext } from "../../../packages/babylon-lite/src/engine/surface";
import type { RenderTask } from "../../../packages/babylon-lite/src/frame-graph/render-task";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { configureSwapchainOverlayScene } from "../../../packages/babylon-lite/src/scene/swapchain-overlay";

function makeSwapchainTask(swapchain: SurfaceContext["scRT"], msaaView?: GPUTextureView): RenderTask {
    const rt = msaaView ? { _colorView: msaaView } : swapchain;
    return {
        _config: { name: "swapchain", rt, rst: msaaView ? swapchain : undefined, clr: true },
        _colorAttachment: { view: msaaView },
    } as unknown as RenderTask;
}

describe("configureSwapchainOverlayScene", () => {
    it("disables single-sample overlay clearing without requiring a base task", () => {
        const swapchain = {} as SurfaceContext["scRT"];
        const overlayTask = makeSwapchainTask(swapchain);
        const baseTasks: RenderTask[] = [];
        let baseLookups = 0;
        const base = {
            _frameGraph: {
                get _tasks(): RenderTask[] {
                    baseLookups++;
                    expect(overlayTask._config.clr).toBe(false);
                    return baseTasks;
                },
            },
        } as unknown as SceneContext;
        const overlay = {
            _frameGraph: { _tasks: [overlayTask] },
            _beforeRender: [],
        } as unknown as SceneContext;
        const surface = {
            scRT: swapchain,
            msaaSamples: 1,
            _renderingContexts: [base],
        } as unknown as SurfaceContext;

        configureSwapchainOverlayScene(surface, overlay);

        expect(overlayTask._config.clr).toBe(false);
        expect(overlay._beforeRender).toHaveLength(0);
        expect(baseLookups).toBe(0);
    });

    it("waits for a late MSAA base attachment before loading and resolving the overlay", () => {
        const swapchain = {} as SurfaceContext["scRT"];
        const overlayView = {} as GPUTextureView;
        const baseView = {} as GPUTextureView;
        const overlayTask = makeSwapchainTask(swapchain, overlayView);
        const baseTasks: RenderTask[] = [];
        let baseLookups = 0;
        const base = {
            _frameGraph: {
                get _tasks(): RenderTask[] {
                    baseLookups++;
                    return baseTasks;
                },
            },
        } as unknown as SceneContext;
        const overlay = {
            _frameGraph: { _tasks: [overlayTask] },
            _beforeRender: [],
        } as unknown as SceneContext;
        const surface = {
            scRT: swapchain,
            msaaSamples: 4,
            _renderingContexts: [base],
        } as unknown as SurfaceContext;

        configureSwapchainOverlayScene(surface, overlay);

        expect(overlayTask._config.clr).toBe(true);
        expect(overlayTask.enabled).toBe(false);
        expect(overlay._beforeRender).toHaveLength(1);
        expect(baseLookups).toBe(0);

        overlay._beforeRender[0]!(0);
        expect(overlayTask._config.clr).toBe(true);
        expect(overlayTask.enabled).toBe(false);
        expect(overlayTask._colorAttachment.view).toBe(overlayView);
        expect(baseLookups).toBe(1);

        baseTasks.push(makeSwapchainTask(swapchain, baseView));
        overlay._beforeRender[0]!(0);
        expect(overlayTask._config.clr).toBe(false);
        expect(overlayTask.enabled).toBeUndefined();
        expect(overlayTask._colorAttachment.view).toBe(baseView);
        expect(baseLookups).toBe(2);
    });

    it("keeps an MSAA overlay disabled when post-process/copy base tasks cannot share an attachment", () => {
        const swapchain = {} as SurfaceContext["scRT"];
        const overlayView = {} as GPUTextureView;
        const overlayTask = makeSwapchainTask(swapchain, overlayView);
        const base = {
            _frameGraph: {
                _tasks: [
                    { targetTexture: swapchain, _colorAttachment: {} },
                    { outputTexture: swapchain, _colorAttachment: {} },
                ],
            },
        } as unknown as SceneContext;
        const overlay = {
            _frameGraph: { _tasks: [overlayTask] },
            _beforeRender: [],
        } as unknown as SceneContext;
        const surface = {
            scRT: swapchain,
            msaaSamples: 4,
            _renderingContexts: [base],
        } as unknown as SurfaceContext;

        configureSwapchainOverlayScene(surface, overlay);
        overlay._beforeRender[0]!(0);
        overlay._beforeRender[0]!(0);

        expect(overlayTask._config.clr).toBe(true);
        expect(overlayTask.enabled).toBe(false);
        expect(overlayTask._colorAttachment.view).toBe(overlayView);
    });
});
