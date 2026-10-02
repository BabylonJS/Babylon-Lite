import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { createRenderTarget } from "../../../packages/babylon-lite/src/engine/render-target";
import type { RenderTarget } from "../../../packages/babylon-lite/src/engine/render-target";
import { createMipMappedRenderTarget } from "../../../packages/babylon-lite/src/engine/render-target-mipmaps";
import { computeStorageBufferBinding } from "../../../packages/babylon-lite/src/compute/compute-storage-buffer-binding";
import { computeUniformBufferBinding } from "../../../packages/babylon-lite/src/compute/compute-uniform-buffer-binding";
import { createUniformBuffer } from "../../../packages/babylon-lite/src/compute/compute-uniform-buffer";
import { createStorageBuffer } from "../../../packages/babylon-lite/src/resource/storage-buffer";
import {
    _getRenderPipeline,
    createRenderBindingSet,
    createRenderShader,
    disposeRenderShader,
    prepareRenderShader,
} from "../../../packages/babylon-lite/src/render-shader/render-shader";
import { createRenderDraw, setRenderDrawCount, setRenderDrawDynamicOffset } from "../../../packages/babylon-lite/src/render-shader/render-draw";
import { setRenderDrawIndirect } from "../../../packages/babylon-lite/src/render-shader/render-draw-indirect";
import { addRenderDraw, createRenderDrawTask, removeRenderDraw, setRenderDrawTaskTarget } from "../../../packages/babylon-lite/src/render-shader/render-draw-task";

interface PassRecord {
    descriptor: GPURenderPassDescriptor;
    loadOp: GPULoadOp | undefined;
    view: GPUTextureView | undefined;
    calls: unknown[][];
}

function makeEngine() {
    const passes: PassRecord[] = [];
    const pipelines: GPURenderPipelineDescriptor[] = [];
    const layouts: GPUBindGroupLayoutDescriptor[] = [];
    const device = {
        limits: {
            maxBufferSize: 256 * 1024 * 1024,
            minUniformBufferOffsetAlignment: 256,
            minStorageBufferOffsetAlignment: 256,
            maxUniformBufferBindingSize: 65536,
            maxStorageBufferBindingSize: 128 * 1024 * 1024,
            maxTextureDimension2D: 4096,
        },
        createTexture: vi.fn(
            (descriptor: GPUTextureDescriptor) =>
                ({
                    format: descriptor.format,
                    createView: vi.fn(() => ({}) as GPUTextureView),
                    destroy: vi.fn(),
                }) as unknown as GPUTexture
        ),
        createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
            const mapped = new ArrayBuffer(Number(descriptor.size));
            return { descriptor, getMappedRange: () => mapped, unmap: vi.fn(), destroy: vi.fn() } as unknown as GPUBuffer;
        }),
        createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => {
            layouts.push(descriptor);
            return descriptor as unknown as GPUBindGroupLayout;
        }),
        createPipelineLayout: vi.fn((descriptor: GPUPipelineLayoutDescriptor) => descriptor as unknown as GPUPipelineLayout),
        createShaderModule: vi.fn((descriptor: GPUShaderModuleDescriptor) => descriptor as unknown as GPUShaderModule),
        createRenderPipeline: vi.fn((descriptor: GPURenderPipelineDescriptor) => {
            pipelines.push(descriptor);
            return { descriptor } as unknown as GPURenderPipeline;
        }),
        createRenderPipelineAsync: vi.fn(async (descriptor: GPURenderPipelineDescriptor) => {
            pipelines.push(descriptor);
            return { descriptor } as unknown as GPURenderPipeline;
        }),
        createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => descriptor as unknown as GPUBindGroup),
        queue: { writeBuffer: vi.fn() },
    } as unknown as GPUDevice;
    const encoder = {
        beginRenderPass: (descriptor: GPURenderPassDescriptor) => {
            const color = (descriptor.colorAttachments as GPURenderPassColorAttachment[])[0];
            const record: PassRecord = { descriptor, loadOp: color?.loadOp, view: color?.view as GPUTextureView | undefined, calls: [] };
            passes.push(record);
            const log =
                (name: string) =>
                (...args: unknown[]) =>
                    record.calls.push([name, ...args.map((arg) => (ArrayBuffer.isView(arg) || Array.isArray(arg) ? [...(arg as number[])] : arg))]);
            return {
                setPipeline: log("setPipeline"),
                setBindGroup: log("setBindGroup"),
                setVertexBuffer: log("setVertexBuffer"),
                setIndexBuffer: log("setIndexBuffer"),
                draw: log("draw"),
                drawIndexed: log("drawIndexed"),
                drawIndirect: log("drawIndirect"),
                drawIndexedIndirect: log("drawIndexedIndirect"),
                end: vi.fn(),
            } as unknown as GPURenderPassEncoder;
        },
    } as unknown as GPUCommandEncoder;
    const engine = { _device: device, _currentEncoder: encoder } as unknown as EngineContext;
    return { engine, device, passes, pipelines, layouts };
}

function makeTarget(format: GPUTextureFormat, label: string): RenderTarget {
    const target = createRenderTarget({ lbl: label, format, samples: 1, size: { width: 8, height: 8 } });
    target._colorTexture = { label } as unknown as GPUTexture;
    target._colorView = { label } as unknown as GPUTextureView;
    target._eager = true;
    return target;
}

function makeDepthTarget(format: GPUTextureFormat): RenderTarget {
    const target = createRenderTarget({ dFormat: format, samples: 1, size: { width: 8, height: 8 } });
    target._depthTexture = { label: format } as GPUTexture;
    target._depthView = { label: format } as GPUTextureView;
    target._eager = true;
    return target;
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

const DAB_SOURCE = `
struct Canvas { size: vec2f };
@group(0) @binding(0) var<uniform> canvas: Canvas;
@vertex fn dabVertex(@builtin(vertex_index) corner: u32, @location(0) dab: vec4f) -> @builtin(position) vec4f { return vec4f(dab.xy / canvas.size, 0.0, 1.0); }
@fragment fn dabFragment() -> @location(0) vec4f { return vec4f(1.0); }`;

const OVER: GPUBlendComponent = { srcFactor: "one", dstFactor: "one-minus-src", operation: "add" };

function createDabProgram(engine: EngineContext) {
    const shader = createRenderShader(engine, {
        name: "dab",
        renderSource: DAB_SOURCE,
        vertexEntryPoint: "dabVertex",
        fragmentEntryPoint: "dabFragment",
        bindings: [computeUniformBufferBinding("canvas", { group: 0, binding: 0 })],
        vertexBuffers: [{ arrayStride: 16, stepMode: "instance", attributes: [{ shaderLocation: 0, offset: 0, format: "float32x4" }] }],
        primitive: { topology: "triangle-strip" },
        target: { blend: { color: OVER, alpha: OVER } },
    });
    const canvas = createUniformBuffer(engine, new Float32Array([8, 8, 0, 0]));
    const instances = createStorageBuffer(engine, 64 * 16, { vertex: true });
    const bindings = createRenderBindingSet(shader, { canvas });
    const draw = createRenderDraw(shader, bindings, { vertexCount: 4, instanceCount: 0, vertexBuffers: [instances] });
    return { shader, canvas, instances, bindings, draw };
}

describe("render shaders", () => {
    it("builds render-visible layouts, fragment-only for writable storage", () => {
        const { engine, layouts } = makeEngine();
        createRenderShader(engine, {
            renderSource: "@vertex fn vertexMain() -> @builtin(position) vec4f { return vec4f(0.0); }",
            bindings: [
                computeUniformBufferBinding("params", { group: 0, binding: 0 }),
                computeStorageBufferBinding("instances", { group: 0, binding: 1, access: "read" }),
                computeStorageBufferBinding("histogram", { group: 1, binding: 0, access: "read-write" }),
            ],
        });
        const visibility = layouts.map((layout) => [...layout.entries].map((entry) => entry.visibility));
        expect(visibility).toEqual([[GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT], [GPUShaderStage.FRAGMENT]]);
    });

    it("compiles one pipeline per target format, with the target's format and the shader's fixed-function state", () => {
        const { engine, pipelines, passes } = makeEngine();
        const { draw } = createDabProgram(engine);
        const strokeA = makeTarget("r16float", "stroke-a");
        const strokeB = makeTarget("r16float", "stroke-b");
        const layer = makeTarget("rgba16float", "layer");
        const task = createRenderDrawTask(engine, { name: "dabs", target: strokeA });
        addRenderDraw(task, draw);
        task.record();

        setRenderDrawCount(draw, 4, 3);
        expect(task.execute!()).toBe(1);
        setRenderDrawTaskTarget(task, strokeB);
        task.execute!();
        setRenderDrawTaskTarget(task, layer);
        task.execute!();

        expect(pipelines.map((pipeline) => [...(pipeline.fragment!.targets as GPUColorTargetState[])].map((target) => target.format))).toEqual([["r16float"], ["rgba16float"]]);
        const first = pipelines[0]!;
        expect(first.vertex.entryPoint).toBe("dabVertex");
        expect(first.fragment!.entryPoint).toBe("dabFragment");
        expect(first.primitive).toEqual({ topology: "triangle-strip" });
        expect((first.fragment!.targets as GPUColorTargetState[])[0]!.blend).toEqual({ color: OVER, alpha: OVER });
        expect(passes.map((pass) => (pass.view as unknown as { label: string }).label)).toEqual(["stroke-a", "stroke-b", "layer"]);
        expect(task.target).toBe(layer);
    });

    it("records instanced draws with vertex buffers into one pass that loads the target by default", () => {
        const { engine, passes } = makeEngine();
        const { draw, instances } = createDabProgram(engine);
        const task = createRenderDrawTask(engine, { target: makeTarget("r16float", "stroke") });
        addRenderDraw(task, draw);
        task.record();
        setRenderDrawCount(draw, 4, 12);

        task.execute!();

        const pass = passes[0]!;
        expect(pass.loadOp).toBe("load");
        expect(pass.calls.map((call) => call[0])).toEqual(["setPipeline", "setBindGroup", "setVertexBuffer", "draw"]);
        expect(pass.calls[2]).toEqual(["setVertexBuffer", 0, instances._buffer]);
        expect(pass.calls[3]).toEqual(["draw", 4, 12, 0, 0]);
    });

    it("opens no pass when every draw is disabled and nothing is cleared, but still clears on request", () => {
        const { engine, passes } = makeEngine();
        const { draw } = createDabProgram(engine);
        const task = createRenderDrawTask(engine, { target: makeTarget("r16float", "stroke") });
        addRenderDraw(task, draw);
        task.record();
        draw.enabled = false;

        expect(task.execute!()).toBe(0);
        expect(passes).toHaveLength(0);

        task.clear = true;
        task.execute!();
        expect(passes).toHaveLength(1);
        expect(passes[0]!.loadOp).toBe("clear");
        expect(passes[0]!.calls).toEqual([]);
    });

    it.each(["color", "depth"] as const)("synchronizes eager targets on each record and when switching to a %s target", (aspect) => {
        const { engine, passes } = makeEngine();
        const first = aspect === "color" ? makeTarget("r16float", "first") : makeDepthTarget("depth32float");
        first._syncEager = vi.fn(() => {
            const view = { label: "refreshed" } as GPUTextureView;
            if (aspect === "color") {
                first._colorView = view;
            } else {
                first._depthView = view;
            }
        });
        const task = createRenderDrawTask(engine, { target: first, clear: true });
        task.record();
        task.execute!();
        task.record();
        task.execute!();
        expect(first._syncEager).toHaveBeenCalledTimes(2);
        expect(aspect === "color" ? passes[1]!.view : passes[1]!.descriptor.depthStencilAttachment?.view).not.toBe(
            aspect === "color" ? passes[0]!.view : passes[0]!.descriptor.depthStencilAttachment?.view
        );
        const descriptor = passes[1]!.descriptor;

        const next = aspect === "color" ? makeTarget("r16float", "next") : makeDepthTarget("depth32float");
        const view = { label: "switched" } as GPUTextureView;
        next._syncEager = vi.fn(() => {
            if (aspect === "color") {
                next._colorView = view;
            } else {
                next._depthView = view;
            }
        });
        setRenderDrawTaskTarget(task, next);
        task.execute!();
        expect(next._syncEager).toHaveBeenCalledExactlyOnceWith(engine);
        expect(passes[2]!.descriptor).toBe(descriptor);
        expect(aspect === "color" ? passes[2]!.view : passes[2]!.descriptor.depthStencilAttachment?.view).toBe(view);
    });

    it.each([false, true])("refreshes same-target depth/stencil attachments and pipelines without recording again (clear: %s)", (clear) => {
        const { engine, pipelines, passes } = makeEngine();
        const { draw } = createDabProgram(engine);
        const descriptor = { format: "rgba8unorm" as const, dFormat: "depth32float" as GPUTextureFormat, samples: 1, size: { width: 8, height: 8 } };
        const target = createMipMappedRenderTarget(descriptor);
        const task = createRenderDrawTask(engine, { target, clear });
        addRenderDraw(task, draw);
        setRenderDrawCount(draw, 4, 1);
        task.record();
        task.execute!();
        const initialView = target._depthView;

        descriptor.dFormat = "depth24plus-stencil8";
        setRenderDrawTaskTarget(task, target);
        task.execute!();

        expect(target._depthView).not.toBe(initialView);
        expect(passes[1]!.descriptor).not.toBe(passes[0]!.descriptor);
        expect(passes[1]!.descriptor.depthStencilAttachment).toMatchObject({
            view: target._depthView,
            depthLoadOp: clear ? "clear" : "load",
            depthStoreOp: "store",
            stencilLoadOp: clear ? "clear" : "load",
            stencilStoreOp: "store",
        });
        expect(pipelines.map((pipeline) => pipeline.depthStencil?.format)).toEqual(["depth32float", "depth24plus-stencil8"]);
        expect(passes[1]!.calls[0]![1]).not.toBe(passes[0]!.calls[0]![1]);

        descriptor.dFormat = "depth32float";
        setRenderDrawTaskTarget(task, target);
        task.execute!();
        expect(passes[2]!.descriptor.depthStencilAttachment).toMatchObject({ view: target._depthView, depthLoadOp: clear ? "clear" : "load", depthStoreOp: "store" });
        expect(passes[2]!.descriptor.depthStencilAttachment).not.toHaveProperty("stencilLoadOp");
        expect(passes[2]!.descriptor.depthStencilAttachment).not.toHaveProperty("stencilStoreOp");
        expect(passes[2]!.calls[0]![1]).toBe(passes[0]!.calls[0]![1]);
        task.execute!();
        expect(pipelines).toHaveLength(2);
    });

    it.each(["format", "dFormat", "depthCompare", "samples"] as const)("checks %s before reusing a target-identity pipeline hit", (field) => {
        const { engine, pipelines } = makeEngine();
        const { shader } = createDabProgram(engine);
        const target = makeTarget("rgba8unorm", "mutable");
        target._descriptor.dFormat = "depth32float";
        const descriptor = { ...target._descriptor };
        const first = _getRenderPipeline(shader, target);
        if (field === "format") {
            target._descriptor.format = "rgba16float";
        } else if (field === "dFormat") {
            target._descriptor.dFormat = "depth24plus-stencil8";
        } else if (field === "depthCompare") {
            target._descriptor.depthCompare = "less";
        } else {
            target._descriptor.samples = 4;
        }
        const changed = _getRenderPipeline(shader, target);
        expect(changed).not.toBe(first);
        expect(_getRenderPipeline(shader, target)).toBe(changed);
        Object.assign(target._descriptor, descriptor, { depthCompare: descriptor.depthCompare });
        expect(_getRenderPipeline(shader, target)).toBe(first);
        expect(pipelines).toHaveLength(2);
    });

    it("allocates borrowed unbuilt targets only once and before their first draw", () => {
        const { engine, device, passes } = makeEngine();
        const descriptor = { format: "r16float" as const, samples: 1, size: { width: 8, height: 8 } };
        const first = createRenderTarget(descriptor);
        const task = createRenderDrawTask(engine, { target: first, clear: true });
        task.record();
        task.record();
        expect(device.createTexture).toHaveBeenCalledTimes(1);

        const next = createRenderTarget(descriptor);
        setRenderDrawTaskTarget(task, next);
        task.execute!();
        expect(device.createTexture).toHaveBeenCalledTimes(2);
        expect(passes[0]!.view).toBe(next._colorView);
        task.dispose();
        expect(() => setRenderDrawTaskTarget(task, createRenderTarget(descriptor))).toThrow(/disposed/);
        expect(device.createTexture).toHaveBeenCalledTimes(2);
    });

    it("draws indexed and indirect draws, and switches back to direct counts", () => {
        const { engine, passes } = makeEngine();
        const shader = createRenderShader(engine, { renderSource: "@vertex fn vertexMain() -> @builtin(position) vec4f { return vec4f(0.0); }" });
        const bindings = createRenderBindingSet(shader, {});
        const indices = createStorageBuffer(engine, new Uint32Array([0, 1, 2]), { index: true });
        const args = createStorageBuffer(engine, 20, { writable: true, indirect: true });
        const draw = createRenderDraw(shader, bindings, { vertexCount: 3, indexBuffer: indices });
        const task = createRenderDrawTask(engine, { target: makeTarget("rgba8unorm", "target") });
        addRenderDraw(task, draw);
        task.record();

        task.execute!();
        setRenderDrawIndirect(draw, args);
        task.execute!();
        setRenderDrawCount(draw, 3, 2);
        task.execute!();

        expect(passes.map((pass) => pass.calls.at(-1)![0])).toEqual(["drawIndexed", "drawIndexedIndirect", "drawIndexed"]);
        expect(passes[0]!.calls.find((call) => call[0] === "setIndexBuffer")).toEqual(["setIndexBuffer", indices._buffer, "uint32"]);
        expect(passes[1]!.calls.at(-1)).toEqual(["drawIndexedIndirect", args._buffer, 0]);
        expect(() => setRenderDrawIndirect(draw, args, 4)).toThrow(/must fit/);
    });

    it("applies retained dynamic offsets per draw", () => {
        const { engine, passes } = makeEngine();
        const shader = createRenderShader(engine, {
            renderSource: "@vertex fn vertexMain() -> @builtin(position) vec4f { return vec4f(0.0); }",
            bindings: [computeUniformBufferBinding("stack", { group: 0, binding: 0, dynamicOffset: true, minBindingSize: 16 })],
        });
        const stacks = createUniformBuffer(engine, 1024);
        const bindings = createRenderBindingSet(shader, { stack: stacks });
        const first = createRenderDraw(shader, bindings, { vertexCount: 3 });
        const second = createRenderDraw(shader, bindings, { vertexCount: 3 });
        setRenderDrawDynamicOffset(second, "stack", 256);
        const task = createRenderDrawTask(engine, { target: makeTarget("rgba16float", "tile") });
        addRenderDraw(task, first);
        addRenderDraw(task, second);
        task.record();

        task.execute!();

        const bindCalls = passes[0]!.calls.filter((call) => call[0] === "setBindGroup").map((call) => call[3]);
        expect(bindCalls).toEqual([[0], [256]]);
        expect(() => setRenderDrawDynamicOffset(second, "stack", 100)).toThrow(/multiple of 256/);
    });

    it("rejects vertex buffers without vertex usage and mismatched buffer counts", () => {
        const { engine } = makeEngine();
        const { shader, bindings } = createDabProgram(engine);
        const plain = createStorageBuffer(engine, 64);

        expect(() => createRenderDraw(shader, bindings, { vertexCount: 4, vertexBuffers: [plain] })).toThrow(/vertex usage/);
        expect(() => createRenderDraw(shader, bindings, { vertexCount: 4 })).toThrow(/declares 1 vertex buffers, received 0/);
    });

    it("prepares pipelines asynchronously and reuses them on the frame path", async () => {
        const { engine, device } = makeEngine();
        const { shader, draw } = createDabProgram(engine);
        const target = makeTarget("r16float", "stroke");

        await prepareRenderShader(shader, target);
        const task = createRenderDrawTask(engine, { target });
        addRenderDraw(task, draw);
        task.record();
        setRenderDrawCount(draw, 4, 1);
        task.execute!();

        expect(device.createRenderPipelineAsync).toHaveBeenCalledTimes(1);
        expect(device.createRenderPipeline).not.toHaveBeenCalled();
    });

    it("shares concurrent preparation across targets with the same signature", async () => {
        const { engine, device } = makeEngine();
        const { shader, draw } = createDabProgram(engine);
        const gate = deferred<GPURenderPipeline>();
        vi.mocked(device.createRenderPipelineAsync).mockReturnValueOnce(gate.promise);
        const first = prepareRenderShader(shader, makeTarget("r16float", "first"));
        const target = makeTarget("r16float", "second");
        const second = prepareRenderShader(shader, target);

        expect(device.createRenderPipelineAsync).toHaveBeenCalledTimes(1);
        const pipeline = { label: "shared" } as GPURenderPipeline;
        gate.resolve(pipeline);
        await Promise.all([first, second]);

        const task = createRenderDrawTask(engine, { target });
        addRenderDraw(task, draw);
        setRenderDrawCount(draw, 4, 1);
        task.record();
        task.execute!();
        expect(device.createRenderPipeline).not.toHaveBeenCalled();
        expect(shader._pipelines?.size).toBe(1);
    });

    it("prepares distinct signatures independently", async () => {
        const { engine, device } = makeEngine();
        const { shader } = createDabProgram(engine);
        const first = deferred<GPURenderPipeline>();
        const second = deferred<GPURenderPipeline>();
        vi.mocked(device.createRenderPipelineAsync).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        const prepared = Promise.all([prepareRenderShader(shader, makeTarget("r16float", "first")), prepareRenderShader(shader, makeTarget("rgba16float", "second"))]);

        expect(device.createRenderPipelineAsync).toHaveBeenCalledTimes(2);
        first.resolve({ label: "first" } as GPURenderPipeline);
        second.resolve({ label: "second" } as GPURenderPipeline);
        await prepared;
        expect(shader._pipelines?.size).toBe(2);
    });

    it("propagates a shared rejection and permits a later retry", async () => {
        const { engine, device } = makeEngine();
        const { shader } = createDabProgram(engine);
        const target = makeTarget("r16float", "stroke");
        const gate = deferred<GPURenderPipeline>();
        const error = new Error("pipeline compilation failed");
        vi.mocked(device.createRenderPipelineAsync).mockReturnValueOnce(gate.promise);
        const first = expect(prepareRenderShader(shader, target)).rejects.toBe(error);
        const second = expect(prepareRenderShader(shader, target)).rejects.toBe(error);
        gate.reject(error);
        await Promise.all([first, second]);

        expect(device.createRenderPipelineAsync).toHaveBeenCalledTimes(1);
        await prepareRenderShader(shader, target);
        expect(device.createRenderPipelineAsync).toHaveBeenCalledTimes(2);
        expect(shader._pipelines?.size).toBe(1);
    });

    it.each(["disposed", "replaced"] as const)("rejects pending preparation after the shader is %s without publishing a pipeline", async (change) => {
        const { engine, device } = makeEngine();
        const { shader } = createDabProgram(engine);
        const gate = deferred<GPURenderPipeline>();
        vi.mocked(device.createRenderPipelineAsync).mockReturnValueOnce(gate.promise);
        const prepared = prepareRenderShader(shader, makeTarget("r16float", "stroke"));
        const cache = shader._pipelines;
        const rejected = expect(prepared).rejects.toThrow(change === "disposed" ? /disposed/ : /recreate the compute graph/);
        if (change === "disposed") {
            disposeRenderShader(shader);
        } else {
            engine._device = makeEngine().device;
        }
        gate.resolve({ label: "obsolete" } as GPURenderPipeline);
        await rejected;

        expect(cache?.size).toBe(0);
        expect(shader._pending?.size ?? 0).toBe(0);
        if (change === "disposed") {
            expect(shader._pipelines).toBeNull();
        }
    });

    it("does not replace a synchronous frame pipeline with a late async compilation", async () => {
        const { engine, device, passes } = makeEngine();
        const { shader, draw } = createDabProgram(engine);
        const gate = deferred<GPURenderPipeline>();
        vi.mocked(device.createRenderPipelineAsync).mockReturnValueOnce(gate.promise);
        const target = makeTarget("r16float", "first");
        const prepared = prepareRenderShader(shader, target);
        const task = createRenderDrawTask(engine, { target });
        addRenderDraw(task, draw);
        setRenderDrawCount(draw, 4, 1);
        task.record();
        task.execute!();
        const synchronous = passes[0]!.calls[0]![1];
        gate.resolve({ label: "late" } as GPURenderPipeline);
        await prepared;

        setRenderDrawTaskTarget(task, makeTarget("r16float", "second"));
        task.execute!();
        expect(device.createRenderPipeline).toHaveBeenCalledTimes(1);
        expect(passes[1]!.calls[0]![1]).toBe(synchronous);
    });

    it.each(["depth32float", "depth24plus-stencil8", "depth32float-stencil8", "stencil8"] as const)("uses only the present aspects of %s", (format) => {
        const { engine, passes } = makeEngine();
        const shader = createRenderShader(engine, { renderSource: "@vertex fn vertexMain() -> @builtin(position) vec4f { return vec4f(0.0); }" });
        const draw = createRenderDraw(shader, createRenderBindingSet(shader, {}), { vertexCount: 3 });
        const task = createRenderDrawTask(engine, { target: makeDepthTarget(format), clear: true });
        addRenderDraw(task, draw);
        task.record();
        task.execute!();

        const attachment = passes[0]!.descriptor.depthStencilAttachment!;
        expect(passes[0]!.descriptor.colorAttachments).toEqual([]);
        if (format === "stencil8") {
            expect(attachment).not.toHaveProperty("depthLoadOp");
            expect(attachment).not.toHaveProperty("depthStoreOp");
            expect(attachment).not.toHaveProperty("depthClearValue");
        } else {
            expect(attachment).toMatchObject({ depthLoadOp: "clear", depthStoreOp: "store", depthClearValue: 0 });
        }
        if (format === "depth32float") {
            expect(attachment).not.toHaveProperty("stencilLoadOp");
        } else {
            expect(attachment).toMatchObject({ stencilLoadOp: "clear", stencilStoreOp: "store", stencilClearValue: 0 });
        }
        task.clear = false;
        task.execute!();
        if (format !== "stencil8") {
            expect(attachment.depthLoadOp).toBe("load");
        }
        if (format !== "depth32float") {
            expect(attachment.stencilLoadOp).toBe("load");
        }
    });

    it("rebuilds aspect operations when switching between depth-only, combined and stencil-only targets", () => {
        const { engine, passes, pipelines } = makeEngine();
        const shader = createRenderShader(engine, {
            renderSource: "@vertex fn vertexMain() -> @builtin(position) vec4f { return vec4f(0.0); }",
            depth: { depthWriteEnabled: true, depthCompare: "less" },
        });
        const draw = createRenderDraw(shader, createRenderBindingSet(shader, {}), { vertexCount: 3 });
        const task = createRenderDrawTask(engine, { target: makeDepthTarget("depth32float"), clear: true });
        addRenderDraw(task, draw);
        task.record();
        task.execute!();
        expect(passes[0]!.descriptor.depthStencilAttachment).not.toHaveProperty("stencilLoadOp");

        setRenderDrawTaskTarget(task, makeDepthTarget("depth24plus-stencil8"));
        task.execute!();
        expect(passes[1]!.descriptor.depthStencilAttachment).toMatchObject({ depthLoadOp: "clear", stencilLoadOp: "clear" });
        expect(pipelines[1]!.depthStencil).toMatchObject({ format: "depth24plus-stencil8", depthWriteEnabled: true, depthCompare: "less" });

        setRenderDrawTaskTarget(task, makeDepthTarget("stencil8"));
        task.execute!();
        expect(passes[2]!.descriptor.depthStencilAttachment).not.toHaveProperty("depthLoadOp");
        expect(passes[2]!.descriptor.depthStencilAttachment).toMatchObject({ stencilLoadOp: "clear" });
        expect(pipelines[2]!.depthStencil).toEqual({ format: "stencil8" });
    });

    it("requires the program to be recreated after the device is replaced or the shader disposed", () => {
        const { engine } = makeEngine();
        const { shader, bindings, draw } = createDabProgram(engine);
        const task = createRenderDrawTask(engine, { target: makeTarget("r16float", "stroke") });
        addRenderDraw(task, draw);
        task.record();
        engine._device = makeEngine().device;

        expect(() => task.execute!()).toThrow(/recreate the compute graph/);
        disposeRenderShader(shader);
        expect(() => createRenderBindingSet(shader, {})).toThrow(/disposed/);
        expect(bindings.shader).toBe(shader);
    });

    it("keeps draws owned by the caller and rejects draws from another engine", () => {
        const { engine } = makeEngine();
        const other = makeEngine();
        const { draw } = createDabProgram(engine);
        const foreign = createDabProgram(other.engine).draw;
        const task = createRenderDrawTask(engine, { target: makeTarget("r16float", "stroke") });

        addRenderDraw(task, draw);
        addRenderDraw(task, draw);
        expect(task.draws).toEqual([draw]);
        expect(() => addRenderDraw(task, foreign)).toThrow(/different engines/);
        removeRenderDraw(task, draw);
        expect(task.draws).toEqual([]);
        task.dispose();
        expect(() => addRenderDraw(task, draw)).toThrow(/disposed/);
    });
});
