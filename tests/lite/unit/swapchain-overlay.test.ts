import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { SurfaceContext } from "../../../packages/babylon-lite/src/engine/surface";
import type { RenderTask } from "../../../packages/babylon-lite/src/frame-graph/render-task";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { configureSwapchainOverlayScene } from "../../../packages/babylon-lite/src/scene/swapchain-overlay";

function makeSwapchainTask(swapchain: SurfaceContext["scRT"], msaaView?: GPUTextureView): RenderTask {
    const rt = msaaView ? { _colorView: msaaView, _descriptor: { samples: 4 } } : swapchain;
    return {
        _config: { name: "swapchain", rt, rst: msaaView ? swapchain : undefined, clr: true },
        _colorAttachment: { view: msaaView },
        _getOutputInfo: () => ({ colorTexture: rt, resolveTexture: msaaView ? swapchain : undefined }),
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

function makeOverlay(surface: SurfaceContext, task: RenderTask | RenderTask[], base: SceneContext): SceneContext {
    const tasks = Array.isArray(task) ? task : [task];
    return { surface, _frameGraph: { _tasks: tasks }, _record: vi.fn(() => 0), _overlayBase: base } as unknown as SceneContext;
}

/** Configure the overlay and return its original record mock, which observes each recorded frame. */
function configure(overlay: SceneContext): ReturnType<typeof vi.fn> {
    const record = overlay._record as unknown as ReturnType<typeof vi.fn>;
    configureSwapchainOverlayScene(overlay);
    return record;
}

function makeBase(tasks: unknown[]): SceneContext {
    return { _kind: "scene", _frameGraph: { _tasks: tasks } } as unknown as SceneContext;
}

describe("configureSwapchainOverlayScene", () => {
    it.each([1, 4])("uses the explicit base even when later contexts are scenes or text at MSAA %i", (samples) => {
        const swapchain = {} as SurfaceContext["scRT"];
        const view = {} as GPUTextureView;
        const baseTask = makeSwapchainTask(swapchain, samples > 1 ? view : undefined);
        const overlayTask = makeSwapchainTask(swapchain, samples > 1 ? ({} as GPUTextureView) : undefined);
        const base = makeBase([baseTask]);
        const later = makeBase([makeSwapchainTask(swapchain, samples > 1 ? ({} as GPUTextureView) : undefined)]);
        const surface = makeSurface(swapchain, samples, [base, later, { _kind: "text-renderer" }]);
        const overlay = makeOverlay(surface, overlayTask, base);

        const record = configure(overlay);
        expect(overlayTask._config.clr).toBe(true);
        expect(record).not.toHaveBeenCalled();

        overlay._record();
        expect(record).toHaveBeenCalledOnce();
        expect(overlayTask._config.clr).toBe(false);
        if (samples > 1) {
            expect(overlayTask._colorAttachment.view).toBe(view);
            const replacement = {} as GPUTextureView;
            baseTask._colorAttachment.view = replacement;
            baseTask._config.rt._colorView = replacement;
            overlay._record();
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

        configure(overlay);
        overlay._record();
        expect(overlayTask._config.clr).toBe(false);
        expect(overlayTask.enabled).toBeUndefined();
        expect(baseLookups).toBe(0);
    });

    it("skips only the frames recorded before a late MSAA base attachment", () => {
        const swapchain = {} as SurfaceContext["scRT"];
        const overlayView = {} as GPUTextureView;
        const baseView = {} as GPUTextureView;
        const overlayTask = makeSwapchainTask(swapchain, overlayView);
        const baseTasks: RenderTask[] = [];
        const overlay = makeOverlay(makeSurface(swapchain, 4, []), overlayTask, makeBase(baseTasks));
        const record = configure(overlay);
        const seen: Array<boolean | undefined> = [];
        record.mockImplementation(() => (seen.push(overlayTask.enabled), 0));

        overlay._record();
        expect(seen).toEqual([false]);
        expect(overlayTask.enabled).toBeUndefined();
        expect(overlayTask._colorAttachment.view).toBe(overlayView);

        baseTasks.push(makeSwapchainTask(swapchain, baseView));
        overlay._record();
        expect(seen).toEqual([false, undefined]);
        expect(overlayTask._config.clr).toBe(false);
        expect(overlayTask._colorAttachment.view).toBe(baseView);
    });

    it("respects the app's live enabled gate at MSAA 4", () => {
        const swapchain = {} as SurfaceContext["scRT"];
        const baseTask = makeSwapchainTask(swapchain, {} as GPUTextureView);
        const overlayTask = makeSwapchainTask(swapchain, {} as GPUTextureView);
        const overlay = makeOverlay(makeSurface(swapchain, 4, []), overlayTask, makeBase([baseTask]));
        const record = configure(overlay);
        const seen: Array<boolean | undefined> = [];
        record.mockImplementation(() => (seen.push(overlayTask.enabled), 0));

        for (const visible of [true, false, true]) {
            overlayTask.enabled = visible;
            overlay._record();
        }
        expect(seen).toEqual([true, false, true]);

        baseTask.enabled = false;
        overlayTask.enabled = true;
        overlay._record();
        expect(seen).toEqual([true, false, true, false]);
        expect(overlayTask.enabled).toBe(true);
    });

    it("skips an MSAA overlay while the root task's execution is paused", () => {
        const swapchain = {} as SurfaceContext["scRT"];
        const baseView = {} as GPUTextureView;
        const overlayView = {} as GPUTextureView;
        const baseTask = makeSwapchainTask(swapchain, baseView);
        const overlayTask = makeSwapchainTask(swapchain, overlayView);
        const overlay = makeOverlay(makeSurface(swapchain, 4, []), overlayTask, makeBase([baseTask]));
        const record = configure(overlay);
        const seen: Array<boolean | undefined> = [];
        record.mockImplementation(() => (seen.push(overlayTask.enabled), 0));

        baseTask.executionEnabled = false;
        overlay._record();
        expect(seen).toEqual([false]);
        expect(overlayTask.enabled).toBeUndefined();
        expect(overlayTask._colorAttachment.view).toBe(overlayView);

        baseTask.executionEnabled = true;
        overlay._record();
        expect(seen).toEqual([false, undefined]);
        expect(overlayTask._colorAttachment.view).toBe(baseView);
    });

    it("keeps an MSAA overlay skipped when post-process/copy base tasks cannot share an attachment", () => {
        const swapchain = {} as SurfaceContext["scRT"];
        const overlayView = {} as GPUTextureView;
        const overlayTask = makeSwapchainTask(swapchain, overlayView);
        const base = makeBase([
            { targetTexture: swapchain, _colorAttachment: {} },
            { outputTexture: swapchain, _colorAttachment: {} },
        ]);
        const overlay = makeOverlay(makeSurface(swapchain, 4, [base]), overlayTask, base);
        const record = configure(overlay);
        const seen: Array<boolean | undefined> = [];
        record.mockImplementation(() => (seen.push(overlayTask.enabled), 0));

        overlay._record();
        overlay._record();

        expect(seen).toEqual([false, false]);
        expect(overlayTask.enabled).toBeUndefined();
        expect(overlayTask._config.clr).toBe(true);
        expect(overlayTask._colorAttachment.view).toBe(overlayView);
    });

    it("borrows the last enabled MSAA resolver instead of the disabled default task", () => {
        const swapchain = {} as SurfaceContext["scRT"];
        const defaultTask = makeSwapchainTask(swapchain, {} as GPUTextureView);
        defaultTask.executionEnabled = false;
        const activeView = {} as GPUTextureView;
        const activeTask = makeSwapchainTask(swapchain, activeView);
        const overlayTask = makeSwapchainTask(swapchain, {} as GPUTextureView);
        const overlay = makeOverlay(makeSurface(swapchain, 4, []), overlayTask, makeBase([defaultTask, activeTask]));

        configure(overlay);
        overlay._record();

        expect(overlayTask._colorAttachment.view).toBe(activeView);
    });

    it("composites a nested overlay chain into the root's MSAA attachment", () => {
        const swapchain = {} as SurfaceContext["scRT"];
        const parentView = {} as GPUTextureView;
        const childView = {} as GPUTextureView;
        const root = makeBase([{ targetTexture: swapchain, _colorAttachment: {} }]);
        const surface = makeSurface(swapchain, 4, [root]);
        const parentTask = makeSwapchainTask(swapchain, parentView);
        const parent = makeOverlay(surface, parentTask, root);
        const childTask = makeSwapchainTask(swapchain, childView);
        const child = makeOverlay(surface, childTask, parent);
        configure(parent);
        const childRecord = configure(child);
        const seen: Array<boolean | undefined> = [];
        childRecord.mockImplementation(() => (seen.push(childTask.enabled), 0));

        parent._record();
        child._record();
        expect(seen).toEqual([false]);
        expect(childTask._colorAttachment.view).toBe(childView);

        const rootView = {} as GPUTextureView;
        (root._frameGraph._tasks as RenderTask[]).unshift(makeSwapchainTask(swapchain, rootView));
        parentTask.enabled = false;
        parent._record();
        child._record();

        expect(seen).toEqual([false, undefined]);
        expect(parentTask._colorAttachment.view).toBe(rootView);
        expect(childTask._config.clr).toBe(false);
        expect(childTask._colorAttachment.view).toBe(rootView);
    });

    it.each([1, 4])("configures initially absent and replacement presentation tasks at MSAA %i", (samples) => {
        const swapchain = {} as SurfaceContext["scRT"];
        const baseView = {} as GPUTextureView;
        const base = makeBase([makeSwapchainTask(swapchain, samples > 1 ? baseView : undefined)]);
        const overlayTasks: RenderTask[] = [];
        const overlay = makeOverlay(makeSurface(swapchain, samples, [base]), overlayTasks, base);
        const record = configure(overlay);

        overlay._record();
        expect(record).toHaveBeenCalledOnce();

        const firstView = {} as GPUTextureView;
        const first = makeSwapchainTask(swapchain, samples > 1 ? firstView : undefined);
        overlayTasks.push(first);
        overlay._record();
        expect(first._config.clr).toBe(false);
        if (samples > 1) {
            expect(first._colorAttachment.view).toBe(baseView);
        }

        const replacement = makeSwapchainTask(swapchain, samples > 1 ? ({} as GPUTextureView) : undefined);
        overlayTasks[0] = replacement;
        overlay._record();
        expect(replacement._config.clr).toBe(false);
        expect(replacement.enabled).toBeUndefined();
        if (samples > 1) {
            expect(replacement._colorAttachment.view).toBe(baseView);
        }
        expect(first._config.clr).toBe(true);
        expect(first.enabled).toBeUndefined();
        expect(first._colorAttachment.view).toBe(samples > 1 ? firstView : undefined);
    });
});
