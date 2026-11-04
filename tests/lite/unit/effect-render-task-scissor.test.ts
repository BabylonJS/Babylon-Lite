import { describe, expect, it } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { RenderTarget } from "../../../packages/babylon-lite/src/engine/render-target";
import { createEffectRenderTask, type EffectRenderTask, type EffectWrapper } from "../../../packages/babylon-lite/src/effect/effect-renderer";

interface PassCall {
    name: string;
    args: unknown[];
}

function makeHarness(
    width: number,
    height: number,
    clear = false
): { task: EffectRenderTask; target: RenderTarget; frame: () => { calls: PassCall[]; draws: number; descriptor: GPURenderPassDescriptor } } {
    let calls: PassCall[] = [];
    let descriptor: GPURenderPassDescriptor;
    const record =
        (name: string) =>
        (...args: unknown[]): void => {
            calls.push({ name, args });
        };
    const pass = {
        setPipeline: record("setPipeline"),
        setBindGroup: record("setBindGroup"),
        setViewport: record("setViewport"),
        setScissorRect: record("setScissorRect"),
        draw: record("draw"),
        end: record("end"),
    };
    const engine = {
        _currentEncoder: {
            beginRenderPass: (value: GPURenderPassDescriptor) => {
                descriptor = value;
                return pass;
            },
        },
    } as unknown as EngineContext;
    const target = { _descriptor: { format: "bgra8unorm", samples: 1 }, _width: width, _height: height, _colorView: {} } as unknown as RenderTarget;
    const effect: EffectWrapper = { name: "scissor-effect", options: { fragmentWGSL: "", bindings: [] } };
    const task = createEffectRenderTask({ name: "scissor-test", effect, target, clear }, engine);
    // Seed the recorded pipeline without constructing a GPU device.
    Object.assign(task, { _pipeline: {} });
    return {
        task,
        target,
        frame: () => {
            calls = [];
            const draws = task.execute!();
            return { calls, draws, descriptor };
        },
    };
}

describe("EffectRenderTask scissor", () => {
    it("draws the whole target when the region is absent or null", () => {
        const { task, frame } = makeHarness(100, 50);
        for (const scissor of [undefined, null]) {
            task.scissor = scissor;
            const { calls, draws } = frame();
            expect(calls.map((c) => c.name)).toEqual(["setPipeline", "draw", "end"]);
            expect(calls[1]!.args).toEqual([3]);
            expect(draws).toBe(1);
        }
    });

    it("rounds pixel edges outward without changing the viewport", () => {
        const { task, frame } = makeHarness(100, 50);
        task.scissor = { x: 0.105, y: 0.25, width: 0.45, height: 0.5 };
        const { calls, draws } = frame();
        expect(calls.map((c) => c.name)).toEqual(["setScissorRect", "setPipeline", "draw", "end"]);
        expect(calls[0]!.args).toEqual([10, 12, 46, 26]);
        expect(calls[2]!.args).toEqual([3]);
        expect(draws).toBe(1);
    });

    it("converts an asymmetric region from a bottom-left origin", () => {
        const { task, frame } = makeHarness(100, 80);
        task.scissor = { x: 0.125, y: 0.125, width: 0.25, height: 0.25 };
        expect(frame().calls[0]!.args).toEqual([12, 50, 26, 20]);
    });

    it.each([
        [{ x: -0.2, y: 0.8, width: 0.5, height: 0.6 }, [0, 0, 30, 10]],
        [{ x: 0.8, y: -0.2, width: 0.6, height: 0.5 }, [80, 35, 20, 15]],
        [{ x: -1, y: -1, width: 3, height: 3 }, [0, 0, 100, 50]],
    ])("clamps an overhanging region %j to the target", (scissor, expected) => {
        const { task, frame } = makeHarness(100, 50);
        task.scissor = scissor;
        expect(frame().calls[0]!.args).toEqual(expected);
    });

    it.each([
        { x: 0.405, y: 0.2, width: 0, height: 0.2 },
        { x: 0.2, y: 0.405, width: 0.2, height: 0 },
        { x: 0.405, y: 0.2, width: -0.001, height: 0.2 },
        { x: 0.2, y: 0.405, width: 0.2, height: -0.001 },
        { x: 1.2, y: 0.1, width: 0.3, height: 0.3 },
        { x: -0.5, y: 0.1, width: 0.3, height: 0.3 },
        { x: 0.1, y: 1.2, width: 0.3, height: 0.3 },
        { x: 0.1, y: -0.5, width: 0.3, height: 0.3 },
    ])("ends the pass without drawing for an empty region %j", (scissor) => {
        const { task, frame } = makeHarness(100, 50);
        task.scissor = scissor;
        const { calls, draws } = frame();
        expect(calls.map((c) => c.name)).toEqual(["end"]);
        expect(draws).toBe(0);
    });

    it("reads live regions and target dimensions without re-recording, and resets on null", () => {
        const { task, target, frame } = makeHarness(100, 50);
        const scissor = { x: 0, y: 0, width: 0.5, height: 0.5 };
        task.scissor = scissor;
        expect(frame().calls[0]!.args).toEqual([0, 25, 50, 25]);
        scissor.x = 0.5;
        target._width = 200;
        target._height = 100;
        expect(frame().calls[0]!.args).toEqual([100, 50, 100, 50]);
        task.scissor = null;
        expect(frame().calls.map((c) => c.name)).toEqual(["setPipeline", "draw", "end"]);
    });

    it.each([false, true])("preserves the attachment clear setting %j even when no draw occurs", (clear) => {
        const { task, frame } = makeHarness(100, 50, clear);
        task.scissor = { x: 0.405, y: 0.405, width: 0, height: 0 };
        const { calls, descriptor, draws } = frame();
        expect(calls.map((c) => c.name)).toEqual(["end"]);
        expect(draws).toBe(0);
        const attachment = [...descriptor.colorAttachments][0]!;
        expect(attachment.loadOp).toBe(clear ? "clear" : "load");
        expect(attachment.storeOp).toBe("store");
    });
});
