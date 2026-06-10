import { describe, expect, it } from "vitest";

import { createRenderTarget } from "../../../packages/babylon-lite/src/engine/render-target";
import { createRenderPass, setRenderPassRenderTarget, setRenderPassRenderTargetDepth } from "../../../packages/babylon-lite/src/frame-graph/render-pass";
import type { Task } from "../../../packages/babylon-lite/src/frame-graph/task";

function makeTask(): Task {
    return {
        name: "test-task",
        engine: {} as Task["engine"],
        scene: {} as Task["scene"],
        _passes: [],
        record(): void {
            return;
        },
        dispose(): void {
            return;
        },
    };
}

function makeRenderTarget(label: string) {
    return createRenderTarget({
        lbl: label,
        format: "bgra8unorm",
        dFormat: "depth24plus-stencil8",
        samples: 1,
        size: { width: 1, height: 1 },
    });
}

describe("RenderPass render target setters", () => {
    it("registers color and depth render targets as pass dependencies", () => {
        const pass = createRenderPass("test-pass", makeTask());
        const colorTarget = makeRenderTarget("color");
        const depthTarget = makeRenderTarget("depth");

        setRenderPassRenderTarget(pass, colorTarget);
        setRenderPassRenderTargetDepth(pass, depthTarget);

        expect(pass._dependencies.has(colorTarget)).toBe(true);
        expect(pass._dependencies.has(depthTarget)).toBe(true);
        expect(pass._dependencies.size).toBe(2);
    });

    it("keeps dependency registration idempotent when setters are called repeatedly", () => {
        const pass = createRenderPass("test-pass", makeTask());
        const colorTarget = makeRenderTarget("color");

        setRenderPassRenderTarget(pass, colorTarget);
        setRenderPassRenderTarget(pass, colorTarget);

        expect(pass._dependencies.has(colorTarget)).toBe(true);
        expect(pass._dependencies.size).toBe(1);
    });
});
