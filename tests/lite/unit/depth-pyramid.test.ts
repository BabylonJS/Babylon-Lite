import { beforeEach, describe, expect, it, vi } from "vitest";

const pool = vi.hoisted(() => ({
    acquireTexture: vi.fn(),
    releaseTexture: vi.fn(),
    getOrCreateSampler: vi.fn(() => ({}) as GPUSampler),
}));

vi.mock("../../../packages/babylon-lite/src/resource/gpu-pool.js", () => pool);

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { createDepthPyramid } from "../../../packages/babylon-lite/src/frame-graph/depth-pyramid";

function makeEngine(): { engine: EngineContext; createShaderModule: ReturnType<typeof vi.fn> } {
    const createShaderModule = vi.fn((descriptor: GPUShaderModuleDescriptor) => descriptor as unknown as GPUShaderModule);
    const texture = {
        createView: vi.fn(() => ({}) as GPUTextureView),
    } as unknown as GPUTexture;
    const device = {
        createBindGroupLayout: vi.fn(() => ({}) as GPUBindGroupLayout),
        createPipelineLayout: vi.fn(() => ({}) as GPUPipelineLayout),
        createShaderModule,
        createRenderPipeline: vi.fn(() => ({}) as GPURenderPipeline),
        createTexture: vi.fn(() => texture),
        createBindGroup: vi.fn(() => ({}) as GPUBindGroup),
    } as unknown as GPUDevice;
    return { engine: { _device: device } as unknown as EngineContext, createShaderModule };
}

describe("depth pyramid reduction", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it.each(["min", "max"] as const)("includes odd source rows and columns for %s reduction", (reduce) => {
        const { engine, createShaderModule } = makeEngine();

        const pyramid = createDepthPyramid(engine, { width: 5, height: 3, reduce });
        const shader = createShaderModule.mock.calls.map(([descriptor]) => (descriptor as GPUShaderModuleDescriptor).code).find((code) => code.includes("extraX"));

        expect(shader).toContain("let extraX=(sd.x&1)==1");
        expect(shader).toContain("let extraY=(sd.y&1)==1");
        expect(shader).toContain(`r=${reduce}(r,`);

        pyramid.dispose();
    });
});
