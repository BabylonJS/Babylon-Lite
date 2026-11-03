import { describe, expect, it } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { SurfaceContext } from "../../../packages/babylon-lite/src/engine/surface";
import type { RenderTask } from "../../../packages/babylon-lite/src/frame-graph/render-task";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { _selectImplicitBase } from "../../../packages/babylon-lite/src/scene/implicit-overlay-base";
import { retargetSwapchainOverlay } from "../../../packages/babylon-lite/src/scene/overlay-lifecycle";
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

describe("configureSwapchainOverlayScene", () => {
    it("uses the selected previous scene rather than a later frame-graph context", () => {
        const swapchain = {} as SurfaceContext["scRT"];
        const previousView = {} as GPUTextureView;
        const latestView = {} as GPUTextureView;
        const unrelatedView = {} as GPUTextureView;
        const previous = { _kind: "scene", _frameGraph: { _tasks: [makeSwapchainTask(swapchain, previousView)] } };
        const latest = { _kind: "scene", _frameGraph: { _tasks: [makeSwapchainTask(swapchain, latestView)] } };
        const unrelated = { _kind: "frame-graph-context", _frameGraph: { _tasks: [makeSwapchainTask(swapchain, unrelatedView)] } };
        const task = makeSwapchainTask(swapchain, {} as GPUTextureView);
        const overlay = { _frameGraph: { _tasks: [task] }, _beforeRender: [], _disposables: [] } as unknown as SceneContext;
        const surface = makeSurface(swapchain, 4, [previous, latest, unrelated]);

        Object.assign(overlay, { surface });
        const base = _selectImplicitBase(overlay);
        expect(base).toBe(latest);
        configureSwapchainOverlayScene(surface, overlay, base);
        overlay._beforeRender.forEach((callback) => callback(0));

        expect(task._config.clr).toBe(false);
        expect(task._colorAttachment.view).toBe(latestView);
    });

    it.each([1, 4])("does not overlay a non-scene frame-graph context when there is no previous scene at MSAA %i", (samples) => {
        const swapchain = {} as SurfaceContext["scRT"];
        const task = makeSwapchainTask(swapchain, samples > 1 ? ({} as GPUTextureView) : undefined);
        const overlay = { _frameGraph: { _tasks: [task] }, _beforeRender: [], _disposables: [] } as unknown as SceneContext;
        const unrelated = { _kind: "frame-graph-context", _frameGraph: { _tasks: [makeSwapchainTask(swapchain)] } };
        const surface = makeSurface(swapchain, samples, [unrelated]);

        Object.assign(overlay, { surface });
        const base = _selectImplicitBase(overlay);
        expect(base).toBeNull();
        configureSwapchainOverlayScene(surface, overlay, base);

        expect(task._config.clr).toBe(true);
        expect(overlay._beforeRender).toHaveLength(0);
    });

    it.each([1, 4])("does not infer a base when explicitly given null at MSAA %i", (samples) => {
        const swapchain = {} as SurfaceContext["scRT"];
        const task = makeSwapchainTask(swapchain, samples > 1 ? ({} as GPUTextureView) : undefined);
        const overlay = { _frameGraph: { _tasks: [task] }, _beforeRender: [], _disposables: [] } as unknown as SceneContext;
        const previous = { _kind: "scene", _frameGraph: { _tasks: [makeSwapchainTask(swapchain)] } };
        const surface = makeSurface(swapchain, samples, [previous]);

        configureSwapchainOverlayScene(surface, overlay, null);

        expect(task._config.clr).toBe(true);
        expect(overlay._beforeRender).toHaveLength(0);
    });

    it.each([1, 4])("uses the supplied base even when a different scene was registered later at MSAA %i", (samples) => {
        const swapchain = {} as SurfaceContext["scRT"];
        const view = {} as GPUTextureView;
        const base = { _kind: "scene", _frameGraph: { _tasks: [makeSwapchainTask(swapchain, samples > 1 ? view : undefined)] } } as unknown as SceneContext;
        const later = { _kind: "scene", _frameGraph: { _tasks: [makeSwapchainTask(swapchain, samples > 1 ? ({} as GPUTextureView) : undefined)] } };
        const task = makeSwapchainTask(swapchain, samples > 1 ? ({} as GPUTextureView) : undefined);
        const overlay = { _frameGraph: { _tasks: [task] }, _beforeRender: [], _disposables: [] } as unknown as SceneContext;
        const surface = makeSurface(swapchain, samples, [base, later]);

        configureSwapchainOverlayScene(surface, overlay, base);
        overlay._beforeRender.forEach((callback) => callback(0));

        expect(task._config.clr).toBe(false);
        if (samples > 1) {
            expect(task._colorAttachment.view).toBe(view);
        }
    });

    it.each([1, 4])("uses the explicit main scene even when the last context is text at MSAA %i", (samples) => {
        const swapchain = {} as SurfaceContext["scRT"];
        const view = {} as GPUTextureView;
        const baseTask = makeSwapchainTask(swapchain, samples > 1 ? view : undefined);
        const overlayTask = makeSwapchainTask(swapchain, samples > 1 ? ({} as GPUTextureView) : undefined);
        const base = { _kind: "scene", _frameGraph: { _tasks: [baseTask] } } as unknown as SceneContext;
        const overlay = { _frameGraph: { _tasks: [overlayTask] }, _beforeRender: [], _disposables: [], _overlayBase: base } as unknown as SceneContext;
        const surface = makeSurface(swapchain, samples, [base, { _kind: "text-renderer" }]);
        Object.assign(overlay, { surface });

        const selected = overlay._overlayBase;
        expect(selected).toBe(base);
        configureSwapchainOverlayScene(surface, overlay, selected ?? null);
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

    it.each([1, 4])("does not choose a later unrelated scene as the base of its own overlay group at MSAA %i", (samples) => {
        const swapchain = {} as SurfaceContext["scRT"];
        const mainTask = makeSwapchainTask(swapchain, samples > 1 ? ({} as GPUTextureView) : undefined);
        const main = { _kind: "scene", _frameGraph: { _tasks: [mainTask] }, _beforeRender: [] } as unknown as SceneContext;
        const layer = { _kind: "scene", _overlayBase: main } as unknown as SceneContext;
        const unrelated = {
            _kind: "scene",
            _frameGraph: { _tasks: [makeSwapchainTask(swapchain, samples > 1 ? ({} as GPUTextureView) : undefined)] },
        } as unknown as SceneContext;
        const surface = makeSurface(swapchain, samples, [layer, unrelated]);
        Object.assign(main, { surface });

        const selected = _selectImplicitBase(main);
        expect(selected).toBeNull();
        configureSwapchainOverlayScene(surface, main, selected);
        expect(mainTask._config.clr).toBe(true);
        expect(main._beforeRender).toHaveLength(0);
    });

    it.each([1, 4])("uses the scene before child-first overlays as the ordinary fallback at MSAA %i", (samples) => {
        const swapchain = {} as SurfaceContext["scRT"];
        const view = {} as GPUTextureView;
        const previous = {
            _kind: "scene",
            _frameGraph: { _tasks: [makeSwapchainTask(swapchain, samples > 1 ? view : undefined)] },
        } as unknown as SceneContext;
        const mainTask = makeSwapchainTask(swapchain, samples > 1 ? ({} as GPUTextureView) : undefined);
        const main = { _frameGraph: { _tasks: [mainTask] }, _beforeRender: [], _disposables: [] } as unknown as SceneContext;
        const layer = { _kind: "scene", _overlayBase: main } as unknown as SceneContext;
        const child = { _kind: "scene", _overlayBase: layer } as unknown as SceneContext;
        const surface = makeSurface(swapchain, samples, [previous, child, layer, { _kind: "text-renderer" }]);
        Object.assign(main, { surface });

        const selected = _selectImplicitBase(main);
        expect(selected).toBe(previous);
        configureSwapchainOverlayScene(surface, main, selected);
        main._beforeRender.forEach((cb) => cb(0));
        expect(mainTask._config.clr).toBe(false);
        if (samples > 1) {
            expect(mainTask._colorAttachment.view).toBe(view);
        }
    });

    it("disables single-sample overlay clearing without requiring a base task", () => {
        const swapchain = {} as SurfaceContext["scRT"];
        const overlayTask = makeSwapchainTask(swapchain);
        const baseTasks: RenderTask[] = [];
        let baseLookups = 0;
        const base = {
            _kind: "scene",
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
            _disposables: [],
        } as unknown as SceneContext;
        const surface = makeSurface(swapchain, 1, [base]);

        configureSwapchainOverlayScene(surface, overlay, base);

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
        const overlay = {
            _frameGraph: { _tasks: [overlayTask] },
            _beforeRender: [],
            _disposables: [],
        } as unknown as SceneContext;
        const surface = makeSurface(swapchain, 4, [base]);

        configureSwapchainOverlayScene(surface, overlay, base);

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

    it("replaces the previous MSAA callback and retargets a re-registered scene", () => {
        const swapchain = {} as SurfaceContext["scRT"];
        const firstTask = makeSwapchainTask(swapchain, {} as GPUTextureView);
        const secondView = {} as GPUTextureView;
        const secondTask = makeSwapchainTask(swapchain, secondView);
        const first = { _kind: "scene", _frameGraph: { _tasks: [firstTask] } } as unknown as SceneContext;
        const second = { _kind: "scene", _frameGraph: { _tasks: [secondTask] } } as unknown as SceneContext;
        const overlayTask = makeSwapchainTask(swapchain, {} as GPUTextureView);
        overlayTask.enabled = true;
        const overlay = { _frameGraph: { _tasks: [overlayTask] }, _beforeRender: [], _disposables: [] } as unknown as SceneContext;
        const surface = makeSurface(swapchain, 4, [first]);

        configureSwapchainOverlayScene(surface, overlay, first);
        firstTask._config.rst = undefined;
        overlay._beforeRender[0]!(0);
        expect(overlayTask.enabled).toBe(false);

        surface._renderingContexts[0] = second;
        retargetSwapchainOverlay(surface, overlay, second);
        expect(overlay._beforeRender).toHaveLength(1);
        overlay._beforeRender[0]!(0);
        expect(overlayTask.enabled).toBe(true);
        expect(overlayTask._config.clr).toBe(false);
        expect(overlayTask._colorAttachment.view).toBe(secondView);
    });

    it.each([1, 4])("restores an earlier overlay's clear state after utility support is enabled at MSAA %i", (samples) => {
        const swapchain = {} as SurfaceContext["scRT"];
        const firstTask = makeSwapchainTask(swapchain, samples > 1 ? ({} as GPUTextureView) : undefined);
        const first = { _kind: "scene", _frameGraph: { _tasks: [firstTask] } } as unknown as SceneContext;
        const mainTask = makeSwapchainTask(swapchain, samples > 1 ? ({} as GPUTextureView) : undefined);
        mainTask.enabled = true;
        const main = { _frameGraph: { _tasks: [mainTask] }, _beforeRender: [], _disposables: [] } as unknown as SceneContext;
        const utility = { _kind: "scene", _overlayBase: main } as unknown as SceneContext;
        const surface = makeSurface(swapchain, samples, [first]);
        Object.assign(main, { surface });

        configureSwapchainOverlayScene(surface, main, first);
        main._beforeRender.forEach((callback) => callback(0));
        expect(mainTask._config.clr).toBe(false);
        if (samples === 1) {
            mainTask.enabled = false;
        }

        surface._renderingContexts.splice(0, 1, utility);
        retargetSwapchainOverlay(surface, main, _selectImplicitBase(main));
        expect(mainTask._config.clr).toBe(true);
        expect(mainTask.enabled).toBe(samples === 1 ? false : true);
        expect(main._beforeRender).toHaveLength(0);
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
        const overlay = {
            _frameGraph: { _tasks: [overlayTask] },
            _beforeRender: [],
            _disposables: [],
        } as unknown as SceneContext;
        const surface = makeSurface(swapchain, 4, [base]);

        configureSwapchainOverlayScene(surface, overlay, base);
        overlay._beforeRender[0]!(0);
        overlay._beforeRender[0]!(0);

        expect(overlayTask._config.clr).toBe(true);
        expect(overlayTask.enabled).toBe(false);
        expect(overlayTask._colorAttachment.view).toBe(overlayView);
    });
});
