import { describe, expect, it } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
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

function makeSurface(swapchain: SurfaceContext["scRT"], samples: number, contexts: unknown[]): SurfaceContext {
    return {
        engine: {} as EngineContext,
        scRT: swapchain,
        msaaSamples: samples,
        _renderingContexts: contexts,
    } as unknown as SurfaceContext;
}

function makeOverlay(surface: SurfaceContext, task: RenderTask, base: SceneContext): SceneContext {
    return { surface, _frameGraph: { _tasks: [task] }, _beforeRender: [], _disposables: [], _overlayBase: base } as unknown as SceneContext;
}

describe("configureSwapchainOverlayScene", () => {
    it.each([1, 4])("uses the explicit base even when later contexts are scenes or text at MSAA %i", (samples) => {
        const swapchain = {} as SurfaceContext["scRT"];
        const view = {} as GPUTextureView;
        const baseTask = makeSwapchainTask(swapchain, samples > 1 ? view : undefined);
        const overlayTask = makeSwapchainTask(swapchain, samples > 1 ? ({} as GPUTextureView) : undefined);
        const base = { _kind: "scene", _frameGraph: { _tasks: [baseTask] } } as unknown as SceneContext;
        const later = { _kind: "scene", _frameGraph: { _tasks: [makeSwapchainTask(swapchain, samples > 1 ? ({} as GPUTextureView) : undefined)] } };
        const surface = makeSurface(swapchain, samples, [base, later, { _kind: "text-renderer" }]);
        const overlay = makeOverlay(surface, overlayTask, base);

        configureSwapchainOverlayScene(overlay);
        overlay._beforeRender.forEach((cb) => cb(0));
        expect(overlayTask._config.clr).toBe(false);
        if (samples > 1) {
            expect(overlayTask._colorAttachment.view).toBe(view);
            const replacement = {} as GPUTextureView;
            baseTask._colorAttachment.view = replacement;
            overlay._beforeRender.forEach((cb) => cb(0));
            expect(overlayTask._colorAttachment.view).toBe(replacement);
        }
    });

    it("disables single-sample overlay clearing without requiring a base task", () => {
        const swapchain = {} as SurfaceContext["scRT"];
        const overlayTask = makeSwapchainTask(swapchain);
        let baseLookups = 0;
        const base = {
            _kind: "scene",
            _frameGraph: {
                get _tasks(): RenderTask[] {
                    baseLookups++;
                    return [];
                },
            },
        } as unknown as SceneContext;
        const overlay = makeOverlay(makeSurface(swapchain, 1, [base]), overlayTask, base);

        configureSwapchainOverlayScene(overlay);

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
            _kind: "scene",
            _frameGraph: {
                get _tasks(): RenderTask[] {
                    baseLookups++;
                    return baseTasks;
                },
            },
        } as unknown as SceneContext;
        const overlay = makeOverlay(makeSurface(swapchain, 4, [base]), overlayTask, base);

        configureSwapchainOverlayScene(overlay);

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
            _kind: "scene",
            _frameGraph: {
                _tasks: [
                    { targetTexture: swapchain, _colorAttachment: {} },
                    { outputTexture: swapchain, _colorAttachment: {} },
                ],
            },
        } as unknown as SceneContext;
        const overlay = makeOverlay(makeSurface(swapchain, 4, [base]), overlayTask, base);

        configureSwapchainOverlayScene(overlay);
        overlay._beforeRender[0]!(0);
        overlay._beforeRender[0]!(0);

        expect(overlayTask._config.clr).toBe(true);
        expect(overlayTask.enabled).toBe(false);
        expect(overlayTask._colorAttachment.view).toBe(overlayView);
    });

    it("propagates an unavailable MSAA attachment through a nested overlay chain", () => {
        const swapchain = {} as SurfaceContext["scRT"];
        const parentView = {} as GPUTextureView;
        const childView = {} as GPUTextureView;
        const base = {
            _kind: "scene",
            _frameGraph: { _tasks: [{ targetTexture: swapchain, _colorAttachment: {} }] },
        } as unknown as SceneContext;
        const surface = makeSurface(swapchain, 4, [base]);
        const parentTask = makeSwapchainTask(swapchain, parentView);
        const parent = makeOverlay(surface, parentTask, base);
        const childTask = makeSwapchainTask(swapchain, childView);
        const child = makeOverlay(surface, childTask, parent);

        configureSwapchainOverlayScene(parent);
        configureSwapchainOverlayScene(child);
        parent._beforeRender[0]!(0);
        child._beforeRender[0]!(0);

        expect(parentTask.enabled).toBe(false);
        expect(childTask.enabled).toBe(false);
        expect(childTask._config.clr).toBe(true);
        expect(childTask._colorAttachment.view).toBe(childView);

        const baseView = {} as GPUTextureView;
        (base._frameGraph._tasks as RenderTask[]).unshift(makeSwapchainTask(swapchain, baseView));
        parent._beforeRender[0]!(0);
        child._beforeRender[0]!(0);

        expect(parentTask._colorAttachment.view).toBe(baseView);
        expect(childTask.enabled).toBeUndefined();
        expect(childTask._config.clr).toBe(false);
        expect(childTask._colorAttachment.view).toBe(baseView);
    });
});
