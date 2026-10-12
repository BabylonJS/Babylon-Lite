import { describe, expect, it, vi } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { createDirectionalLight } from "../../../packages/babylon-lite/src/light/directional-light";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { createEsmDirectionalShadowGenerator, getEsmShadowTaskResources } from "../../../packages/babylon-lite/src/shadow/esm-directional-shadow-generator";

vi.mock("../../../packages/babylon-lite/src/frame-graph/render-task.js", () => ({
    createRenderTask: () => ({ execute: () => 3, dispose: vi.fn() }),
    addMeshToTask: vi.fn(),
}));

describe("ESM blur pass sequencing", () => {
    it("records horizontal then vertical blur with unchanged targets, bindings, and draw count", () => {
        const device = {
            createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
            createTexture: vi.fn(() => ({ createView: vi.fn(() => ({})), destroy: vi.fn() })),
            createSampler: vi.fn(() => ({})),
            createShaderModule: vi.fn(() => ({})),
            createBindGroupLayout: vi.fn(() => ({})),
            createPipelineLayout: vi.fn(() => ({})),
            createRenderPipeline: vi.fn(() => ({})),
            createBindGroup: vi.fn(() => ({})),
            queue: { writeBuffer: vi.fn() },
        } as unknown as GPUDevice;
        const passes: { descriptor: GPURenderPassDescriptor; commands: unknown[][] }[] = [];
        const encoder = {
            beginRenderPass(descriptor: GPURenderPassDescriptor) {
                const commands: unknown[][] = [];
                passes.push({ descriptor, commands });
                return {
                    setPipeline: (pipeline: GPURenderPipeline) => commands.push(["pipeline", pipeline]),
                    setBindGroup: (index: number, binding: GPUBindGroup) => commands.push(["binding", index, binding]),
                    draw: (vertices: number) => commands.push(["draw", vertices]),
                    end: () => commands.push(["end"]),
                };
            },
        } as unknown as GPUCommandEncoder;
        const engine = { _device: device, _currentEncoder: encoder, useFloatingOrigin: false } as unknown as EngineContext;
        const light = createDirectionalLight([1, -1, 1], 1);
        const generator = createEsmDirectionalShadowGenerator(engine, light, { mapSize: 64, blurScale: 2 });
        const scene = { camera: null } as SceneContext;
        const state = generator._ensureShadowTaskState!(engine, scene, []);
        const resources = getEsmShadowTaskResources(generator)!;

        expect(generator._renderShadowMap!(engine, state)).toBe(5);
        expect(passes).toHaveLength(2);
        const targets = [resources._blurTexH, generator._depthTexture];
        const bindings = [resources._blurHBG, resources._blurVBG];
        for (let index = 0; index < passes.length; index++) {
            const target = targets[index]!;
            const view = vi.mocked(target.createView).mock.results.at(-1)!.value;
            expect(passes[index]!.descriptor).toEqual({
                colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
            });
            expect(passes[index]!.commands).toEqual([["pipeline", resources._blurPipeline], ["binding", 0, bindings[index]], ["draw", 3], ["end"]]);
        }
        expect(generator._renderShadowMap!(engine, state)).toBe(0);
        expect(passes).toHaveLength(2);
    });
});
