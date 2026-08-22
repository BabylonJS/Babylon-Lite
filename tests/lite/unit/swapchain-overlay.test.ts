import { describe, expect, it } from "vitest";

import type { SurfaceContext } from "../../../packages/babylon-lite/src/engine/surface";
import type { RenderTask } from "../../../packages/babylon-lite/src/frame-graph/render-task";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { configureSwapchainOverlayScene } from "../../../packages/babylon-lite/src/scene/swapchain-overlay";

function makeSwapchainTask(swapchain: SurfaceContext["scRT"]): RenderTask {
    return {
        _config: { name: "swapchain", rt: swapchain, clr: true },
        _colorAttachment: {},
    } as unknown as RenderTask;
}

describe("configureSwapchainOverlayScene", () => {
    it("disables overlay clearing before an unavailable base task is added", () => {
        const swapchain = {} as SurfaceContext["scRT"];
        const overlayTask = makeSwapchainTask(swapchain);
        const baseTasks: RenderTask[] = [];
        const base = {
            _frameGraph: {
                get _tasks(): RenderTask[] {
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

        const baseTask = makeSwapchainTask(swapchain);
        baseTasks.push(baseTask);
        expect([...baseTasks]).toEqual([baseTask]);
        const overlayLoadOp = overlayTask._config.clr ? "clear" : "load";
        expect(overlayLoadOp).toBe("load");
    });
});
