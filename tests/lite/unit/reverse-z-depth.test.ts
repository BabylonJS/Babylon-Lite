import { describe, expect, it } from "vitest";

import { createRenderTarget, targetSignatureKey } from "../../../packages/babylon-lite/src/engine/render-target";
import { createRenderPass, setRenderPassRenderTarget } from "../../../packages/babylon-lite/src/frame-graph/render-pass";
import type { Task } from "../../../packages/babylon-lite/src/frame-graph/task";
import { mat4PerspectiveLH } from "../../../packages/babylon-lite/src/math/mat4-perspective-lh";
import type { Mat4 } from "../../../packages/babylon-lite/src/math/types";
import { createPickingRay } from "../../../packages/babylon-lite/src/picking/ray";

function projectDepth(matrix: Mat4, z: number): number {
    const clipZ = matrix[10]! * z + matrix[14]!;
    const clipW = matrix[11]! * z + matrix[15]!;
    return clipZ / clipW;
}

function makeTask(): Task {
    return {
        name: "reverse-z-test-task",
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

describe("reverse-Z depth", () => {
    it("maps perspective near depth to 1 and far depth to 0", () => {
        const near = 0.25;
        const far = 1000;
        const projection = mat4PerspectiveLH(Math.PI / 3, 16 / 9, near, far);

        expect(projectDepth(projection, near)).toBeCloseTo(1, 6);
        expect(projectDepth(projection, far)).toBeCloseTo(0, 6);
        expect(projectDepth(projection, 10)).toBeGreaterThan(projectDepth(projection, 100));
    });

    it("defaults render targets and pipeline signatures to reverse-Z", () => {
        const rt = createRenderTarget({
            colorFormat: "bgra8unorm",
            depthStencilFormat: "depth24plus-stencil8",
            sampleCount: 1,
            size: { width: 1, height: 1 },
        });

        expect(rt._descriptor._depthClearValue).toBeUndefined();
        expect(rt._descriptor._depthCompare).toBeUndefined();
        expect(targetSignatureKey({ _colorFormat: "bgra8unorm", _depthStencilFormat: "depth24plus-stencil8", _sampleCount: 1 })).toBe("bgra8unorm|depth24plus-stencil8||1|");
    });

    it("allows internal shadow targets to keep standard-Z depth maps", () => {
        const rt = createRenderTarget({
            depthStencilFormat: "depth32float",
            _depthClearValue: 1,
            _depthCompare: "less-equal",
            sampleCount: 1,
            size: { width: 1, height: 1 },
        });

        expect(rt._descriptor._depthClearValue).toBe(1);
        expect(rt._descriptor._depthCompare).toBe("less-equal");
        expect(targetSignatureKey({ _depthStencilFormat: "depth32float", _depthCompare: "less-equal", _sampleCount: 1 })).toContain("less-equal");
    });

    it("initializes render-pass depth attachments with reverse-Z clear by default", () => {
        const rt = createRenderTarget({
            colorFormat: "bgra8unorm",
            depthStencilFormat: "depth24plus-stencil8",
            sampleCount: 1,
            size: { width: 1, height: 1 },
        });
        rt._colorView = {} as GPUTextureView;
        rt._depthView = {} as GPUTextureView;

        const pass = createRenderPass("reverse-z-pass", makeTask());
        setRenderPassRenderTarget(pass, rt);
        pass._initialize();

        expect(pass._depthAttachment?.depthClearValue).toBe(0);
    });

    it("unprojects picking rays from reverse-Z near and far depths", () => {
        const near = 0.25;
        const far = 1000;
        const projection = mat4PerspectiveLH(Math.PI / 3, 1, near, far);

        const ray = createPickingRay(50, 50, projection, 100, 100);

        expect(ray).not.toBeNull();
        expect(ray!.origin[0]).toBeCloseTo(0, 6);
        expect(ray!.origin[1]).toBeCloseTo(0, 6);
        expect(ray!.origin[2]).toBeCloseTo(near, 6);
        expect(ray!.direction[0]).toBeCloseTo(0, 6);
        expect(ray!.direction[1]).toBeCloseTo(0, 6);
        expect(ray!.direction[2]).toBeCloseTo(1, 6);
        expect(ray!.length).toBeCloseTo(far - near, 3);
    });
});
