import { describe, expect, it, vi } from "vitest";
import type { SsaoGpu } from "../../../packages/babylon-lite/src/post-process/ssao-gpu.js";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import { createFreeCamera } from "../../../packages/babylon-lite/src/camera/free-camera.js";
import { createRenderTarget } from "../../../packages/babylon-lite/src/engine/render-target.js";
import { createSsaoTask } from "../../../packages/babylon-lite/src/post-process/ssao.js";
import { createSsaoMotionPruningGpu, enableSsaoMotionPruning } from "../../../packages/babylon-lite/src/post-process/ssao-motion-pruning.js";
import { ssaoMotionMaskCellCount } from "../../../packages/babylon-lite/src/post-process/ssao-motion-mask-wgsl.js";
import {
    bindXegtaoTemporalGpu,
    createXegtaoTemporalGpu,
    disposeXegtaoTemporalGpu,
    executeXegtaoTemporalGpu,
} from "../../../packages/babylon-lite/src/post-process/ssao-xegtao-gpu.js";

function fixture(filterable = true) {
    const allocations: { descriptor: GPUTextureDescriptor; texture: GPUTexture }[] = [];
    const createTexture = vi.fn((descriptor: GPUTextureDescriptor) => {
        const size = descriptor.size as GPUExtent3DDict | number[];
        const width = Array.isArray(size) ? size[0]! : size.width;
        const height = Array.isArray(size) ? size[1]! : (size.height ?? 1);
        const texture = {
            label: descriptor.label ?? "",
            format: descriptor.format,
            mipLevelCount: descriptor.mipLevelCount ?? 1,
            width,
            height,
            createView: vi.fn(() => ({ texture }) as unknown as GPUTextureView),
            destroy: vi.fn(),
        } as unknown as GPUTexture;
        allocations.push({ descriptor, texture });
        return texture;
    });
    const createBindGroup = vi.fn((_descriptor: GPUBindGroupDescriptor) => ({}) as GPUBindGroup);
    const createRenderPipeline = vi.fn(
        (descriptor: GPURenderPipelineDescriptor) =>
            ({
                label: descriptor.label,
                getBindGroupLayout: vi.fn(() => ({}) as GPUBindGroupLayout),
            }) as unknown as GPURenderPipeline
    );
    const uniform = { destroy: vi.fn() } as unknown as GPUBuffer;
    let buffers = 0;
    const device = {
        features: new Set(filterable ? ["float32-filterable"] : []),
        createTexture,
        createBindGroup,
        createRenderPipeline,
        createBuffer: vi.fn(() => (buffers++ === 0 ? uniform : ({ destroy: vi.fn() } as unknown as GPUBuffer))),
        createComputePipeline: vi.fn(
            (descriptor: GPUComputePipelineDescriptor) =>
                ({ label: descriptor.label, getBindGroupLayout: vi.fn(() => ({}) as GPUBindGroupLayout) }) as unknown as GPUComputePipeline
        ),
        createBindGroupLayout: vi.fn(() => ({}) as GPUBindGroupLayout),
        createPipelineLayout: vi.fn(() => ({}) as GPUPipelineLayout),
        createShaderModule: vi.fn(() => ({}) as GPUShaderModule),
        createSampler: vi.fn(() => ({}) as GPUSampler),
        queue: { writeBuffer: vi.fn() },
    } as unknown as GPUDevice;
    const owner = {
        device,
        width: 63,
        height: 49,
        kind: "float",
        providedNormals: true,
        worldNormals: false,
        sourceDepth: {} as GPUTextureView,
        sourceNormal: {} as GPUTextureView,
        dummyNormalView: {} as GPUTextureView,
        resolveLayout: {} as GPUBindGroupLayout,
        resolveGroup: {} as GPUBindGroup,
        uniform: {} as GPUBuffer,
        working: createTexture({ size: [63, 49], format: "r32uint", usage: 4 }),
        visibility: createTexture({ size: [63, 49], format: "rgba16float", usage: 4 }),
    } as SsaoGpu;
    return { owner, device, allocations, createTexture, createBindGroup, createRenderPipeline, uniform };
}

describe("XeGTAO temporal reconstruction", () => {
    it("fills every motion-bounds level in one cleared dispatch and gates transport indirectly", () => {
        const f = fixture();
        const velocity = {} as GPUTextureView;
        const state = createXegtaoTemporalGpu(f.owner, velocity, true, true);
        const pruning = createSsaoMotionPruningGpu(state);
        state.transportExtension = pruning;
        bindXegtaoTemporalGpu(state, velocity);
        // 63x49 receivers -> 8x7 tiles; levels 8x7, 4x3, 2x1 and 1x1 hold 71 four-word cells.
        expect(ssaoMotionMaskCellCount(63, 49)).toBe(71);
        expect(vi.mocked(f.device.createBuffer).mock.calls.some(([descriptor]) => descriptor.label === "ssao-object-motion-mask" && descriptor.size === 71 * 16)).toBe(true);
        expect(pruning.stages).toHaveLength(1);
        expect(state.stages[0][0]!.indirect).toBe(pruning.indirect);
        const textures = f.createTexture.mock.calls.length,
            groups = f.createBindGroup.mock.calls.length;
        const render = { setPipeline: vi.fn(), setBindGroup: vi.fn(), draw: vi.fn(), drawIndirect: vi.fn(), end: vi.fn() };
        const compute = { setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: vi.fn(), end: vi.fn() };
        const clearBuffer = vi.fn();
        const encoder = { beginRenderPass: () => render, beginComputePass: () => compute, clearBuffer } as unknown as GPUCommandEncoder;
        executeXegtaoTemporalGpu(state, encoder);
        bindXegtaoTemporalGpu(state, velocity);
        executeXegtaoTemporalGpu(state, encoder);
        expect(render.drawIndirect).toHaveBeenCalledTimes(2);
        expect(compute.dispatchWorkgroups).toHaveBeenCalledTimes(2);
        expect(compute.dispatchWorkgroups).toHaveBeenCalledWith(8, 7);
        // Zero is both the empty rectangle and the zero-vertex draw.
        expect(clearBuffer.mock.calls.map(([buffer]) => buffer)).toEqual([pruning.motionCells, pruning.indirect, pruning.motionCells, pruning.indirect]);
        expect(f.createTexture).toHaveBeenCalledTimes(textures);
        expect(f.createBindGroup).toHaveBeenCalledTimes(groups);
        disposeXegtaoTemporalGpu(state);
    });
    it("uses unpruned transport by default without motion-mask allocations, shaders, or dispatches", () => {
        const f = fixture();
        const state = createXegtaoTemporalGpu(f.owner, {} as GPUTextureView, true, true);
        expect(state.transportExtension).toBeUndefined();
        expect(state.stages[0][0]!.indirect).toBeUndefined();
        expect(f.device.createComputePipeline).not.toHaveBeenCalled();
        expect(f.allocations.some(({ texture }) => texture.label === "ssao-object-motion-mask")).toBe(false);
        const modules = vi.mocked(f.device.createShaderModule).mock.calls;
        expect(modules.some(([descriptor]) => descriptor.code.includes("movingCaster"))).toBe(false);
        const render = { setPipeline: vi.fn(), setBindGroup: vi.fn(), draw: vi.fn(), drawIndirect: vi.fn(), end: vi.fn() };
        const encoder = { beginRenderPass: () => render, beginComputePass: vi.fn() } as unknown as GPUCommandEncoder;
        executeXegtaoTemporalGpu(state, encoder);
        expect(encoder.beginComputePass).not.toHaveBeenCalled();
        expect(render.drawIndirect).not.toHaveBeenCalled();
        disposeXegtaoTemporalGpu(state);
    });
    it("toggles pruning without replacing history, then rebinds sources and releases optional resources", () => {
        const f = fixture();
        const camera = createFreeCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
        const depth = createRenderTarget({ dFormat: "depth32float", samples: 1, size: { width: 63, height: 49 } });
        const velocity = createRenderTarget({ format: "rgba32float", samples: 1, size: { width: 63, height: 49 } });
        const task = createSsaoTask({ camera, depthTexture: depth, temporal: { velocityTexture: velocity, velocityHasPreviousDepth: true } }, {
            _device: f.device,
        } as EngineContext);
        const temporal = task.temporal;
        const settings = enableSsaoMotionPruning(task);
        expect(enableSsaoMotionPruning(task)).toBe(settings);
        expect(settings.enabled).toBe(true);
        const velocityView = {} as GPUTextureView;
        const state = createXegtaoTemporalGpu(f.owner, velocityView, true, true);
        const histories = state.history,
            counts = state.counts,
            geometry = state.geometry,
            publicOutput = f.owner.visibility;
        state.index = 1;
        state.data[48] = 0;
        state.data[49] = 16;
        temporal._prepareGpu!(state, velocityView);
        bindXegtaoTemporalGpu(state, velocityView);
        const extension = state.transportExtension!;
        const groups = f.createBindGroup.mock.calls.length;
        temporal._prepareGpu!(state, velocityView);
        bindXegtaoTemporalGpu(state, velocityView);
        expect(f.createBindGroup).toHaveBeenCalledTimes(groups);
        f.owner.sourceDepth = {} as GPUTextureView;
        temporal._prepareGpu!(state, velocityView);
        expect(f.createBindGroup).toHaveBeenCalledTimes(groups + 1);
        bindXegtaoTemporalGpu(state, velocityView);
        expect(state.transportExtension).toBe(extension);
        settings.enabled = false;
        temporal._prepareGpu!(state, velocityView);
        bindXegtaoTemporalGpu(state, velocityView);
        expect(state.transportExtension).toBeUndefined();
        expect(extension.indirect.destroy).toHaveBeenCalledOnce();
        expect(state.stages[1][0]!.pipeline).toBe(state.transportPipeline);
        expect(state.stages[1][0]!.indirect).toBeUndefined();
        settings.enabled = true;
        temporal._prepareGpu!(state, velocityView);
        bindXegtaoTemporalGpu(state, velocityView);
        const next = state.transportExtension!;
        expect(next).not.toBe(extension);
        expect(state.stages[1][0]!.indirect).toBe(next.indirect);
        expect(state.history).toBe(histories);
        expect(state.counts).toBe(counts);
        expect(state.geometry).toBe(geometry);
        expect(f.owner.visibility).toBe(publicOutput);
        expect(state.index).toBe(1);
        expect(state.data[48]).toBe(0);
        expect(state.data[49]).toBe(16);
        temporal.enabled = false;
        temporal._prepareGpu!(state, velocityView);
        expect(next.indirect.destroy).toHaveBeenCalledOnce();
        expect(state.transportExtension).toBeUndefined();
        temporal.enabled = true;
        temporal._prepareGpu!(state, velocityView);
        const last = state.transportExtension!;
        disposeXegtaoTemporalGpu(state);
        disposeXegtaoTemporalGpu(state);
        expect(last.indirect.destroy).toHaveBeenCalledOnce();
        for (const { texture } of f.allocations.slice(3)) {
            expect(texture.destroy).toHaveBeenCalledOnce();
        }
        task.dispose();
    });
    it("does not allocate or draw dilated motion when exact receiver depth is supplied", () => {
        const f = fixture();
        const state = createXegtaoTemporalGpu(f.owner, {} as GPUTextureView, true, true);
        expect(state.motionPipeline).toBeNull();
        expect(state.closestMotion).toBeNull();
        expect(state.stages[0].some((stage) => stage.pipeline.label === "ssao-xegtao-closest-motion")).toBe(false);
    });
    it("retains native feedback formats and mip-by-mip conversion", () => {
        const f = fixture();
        const state = createXegtaoTemporalGpu(f.owner, {} as GPUTextureView);
        expect(state.history.map((texture) => texture.format)).toEqual(["r8unorm", "r8unorm"]);
        expect(state.counts.map((texture) => texture.format)).toEqual(["r16float", "r16float"]);
        expect(state.geometry.format).toBe("rg32uint");
        expect(state.geometry.width).toBe(f.owner.width);
        expect(state.geometry.height).toBe(f.owner.height);
        expect(f.allocations.filter(({ texture }) => texture.label.startsWith("ssao-history-geometry-"))).toHaveLength(1);
        expect(state.convolution.format).toBe("r8unorm");
        expect(state.convolutionDepth.format).toBe("r32float");
        expect(state.convolution.mipLevelCount).toBe(5);
        expect(state.stages[0].map((stage) => stage.pipeline.label)).toEqual([
            "ssao-xegtao-closest-motion",
            "ssao-xegtao-temporal",
            ...Array<string>(4).fill("ssao-xegtao-convolution"),
            "ssao-xegtao-history-repair",
            "ssao-xegtao-output",
        ]);
        expect(f.createRenderPipeline.mock.calls[0]![0].fragment!.constants).toEqual({ PROVIDED_NORMALS: 1, WORLD_NORMALS: 0, HAS_VELOCITY: 1, HAS_TRANSPORT: 0 });
        expect(f.createRenderPipeline.mock.calls[0]![0].fragment!.targets).toEqual([{ format: "r8unorm" }, { format: "r16float" }, { format: "r32float" }]);
        // The final spatial filter writes the eight-bit feedback, public visibility and geometry together.
        const output = f.createRenderPipeline.mock.calls.find(([descriptor]) => descriptor.label === "ssao-xegtao-output")![0];
        expect(output.fragment!.targets).toEqual([{ format: "r8unorm" }, { format: "rgba16float" }, { format: "rg32uint" }]);
        expect(output.fragment!.constants).toEqual({ PROVIDED_NORMALS: 1, WORLD_NORMALS: 0 });
        expect(f.createRenderPipeline.mock.calls.some(([descriptor]) => descriptor.label === "ssao-xegtao-spatial")).toBe(false);
    });
    it("reads prior geometry in both history lanes and overwrites it only in the existing final-output pass", () => {
        const f = fixture();
        const state = createXegtaoTemporalGpu(f.owner, {} as GPUTextureView, true, true);
        const descriptorFor = (group: GPUBindGroup) => f.createBindGroup.mock.calls[f.createBindGroup.mock.results.findIndex((result) => result.value === group)]![0];
        for (const stages of state.stages) {
            const transport = stages.find((stage) => stage.pipeline === state.transportPipeline)!;
            const temporal = stages.find((stage) => stage.pipeline === state.temporalPipeline)!;
            const output = stages.at(-1)!;
            expect(output.pipeline).toBe(state.outputPipeline);
            expect(Array.from(temporal.pass.colorAttachments)).toHaveLength(3);
            expect(Array.from(temporal.pass.colorAttachments).map((attachment) => attachment?.view)).not.toContainEqual({ texture: state.geometry });
            expect(Array.from(output.pass.colorAttachments)).toHaveLength(3);
            expect(Array.from(output.pass.colorAttachments).map((attachment) => attachment?.view)).toEqual([
                { texture: state.history[stages === state.stages[0] ? 1 : 0] },
                { texture: f.owner.visibility },
                { texture: state.geometry },
            ]);
            for (const [stage, binding] of [
                [transport, 6],
                [temporal, 5],
            ] as const) {
                expect(Array.from(descriptorFor(stage.group).entries).find((entry) => entry.binding === binding)!.resource).toEqual({ texture: state.geometry });
            }
            const outputEntries = Array.from(descriptorFor(output.group).entries);
            expect(outputEntries.find((entry) => entry.binding === 1)!.resource).toBe(state.sourceDepth);
            expect(outputEntries.find((entry) => entry.binding === 4)!.resource).toEqual({ texture: state.repaired });
            expect(outputEntries.find((entry) => entry.binding === 5)!.resource).toEqual({ buffer: state.uniform });
            expect(outputEntries.map((entry) => entry.resource)).not.toContainEqual({ texture: state.geometry });
        }
        expect(state.stages[0]).toHaveLength(8);
        disposeXegtaoTemporalGpu(state);
        disposeXegtaoTemporalGpu(state);
        expect(state.geometry.destroy).toHaveBeenCalledOnce();
    });
    it("reuses pass descriptors, resources, and bind groups across frames", () => {
        const f = fixture();
        const state = createXegtaoTemporalGpu(f.owner, null);
        const textures = f.createTexture.mock.calls.length,
            groups = f.createBindGroup.mock.calls.length;
        const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), draw: vi.fn(), end: vi.fn() };
        const encoder = { beginRenderPass: vi.fn(() => pass) } as unknown as GPUCommandEncoder;
        bindXegtaoTemporalGpu(state, null);
        executeXegtaoTemporalGpu(state, encoder);
        expect(state.index).toBe(1);
        executeXegtaoTemporalGpu(state, encoder);
        expect(state.index).toBe(0);
        expect(f.createTexture).toHaveBeenCalledTimes(textures);
        expect(f.createBindGroup).toHaveBeenCalledTimes(groups);
        expect(pass.draw).toHaveBeenCalledTimes(14);
        expect(pass.draw).toHaveBeenCalledWith(3);
        expect(state.transport).toBeNull();
    });
    it("invalidates borrowed source bindings without replacing owned textures", () => {
        const f = fixture();
        const state = createXegtaoTemporalGpu(f.owner, null);
        const textures = f.createTexture.mock.calls.length,
            groups = f.createBindGroup.mock.calls.length;
        f.owner.sourceDepth = {} as GPUTextureView;
        bindXegtaoTemporalGpu(state, null);
        expect(state.sourceDepth).toBe(f.owner.sourceDepth);
        expect(f.createBindGroup.mock.calls.length).toBeGreaterThan(groups);
        expect(f.createTexture).toHaveBeenCalledTimes(textures);
    });
    it.each([true, false])("constructs the supported float32 depth variant (%s)", (filterable) => {
        const f = fixture(filterable);
        const state = createXegtaoTemporalGpu(f.owner, null);
        expect(state.repairPipeline.label).toBe("ssao-xegtao-history-repair");
        const descriptor = f.createRenderPipeline.mock.calls.find(([value]) => value.label === "ssao-xegtao-history-repair")![0];
        expect(descriptor.fragment!.targets).toEqual([{ format: "r8unorm" }]);
    });
    it("keeps transport opt-in and destroys only owned resources once", () => {
        const f = fixture();
        const original = f.owner.resolveGroup;
        const state = createXegtaoTemporalGpu(f.owner, {} as GPUTextureView, true);
        state.transportExtension = createSsaoMotionPruningGpu(state);
        expect(state.transportPipeline?.label).toBe("ssao-occlusion-history-transport");
        f.owner.resolveGroup = state.scratchResolve;
        disposeXegtaoTemporalGpu(state);
        disposeXegtaoTemporalGpu(state);
        expect(f.owner.resolveGroup).toBe(original);
        expect(f.uniform.destroy).toHaveBeenCalledOnce();
        expect(state.transportExtension.indirect.destroy).toHaveBeenCalledOnce();
        for (const { texture } of f.allocations.slice(3)) {
            expect(texture.destroy).toHaveBeenCalledOnce();
        }
        expect(f.owner.visibility.destroy).not.toHaveBeenCalled();
        expect(() => createXegtaoTemporalGpu(f.owner, null, true)).toThrow("object velocity");
    });
});
