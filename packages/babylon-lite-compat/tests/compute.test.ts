import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    createStorageBuffer: vi.fn(),
    updateStorageBufferRange: vi.fn(),
    readStorageBufferAfterFrame: vi.fn(),
    clearStorageBuffer: vi.fn(),
    disposeStorageBuffer: vi.fn(),
    createUniformBuffer: vi.fn(),
    updateUniformBuffer: vi.fn(),
    disposeUniformBuffer: vi.fn(),
    computeStorageBufferBinding: vi.fn(),
    computeUniformBufferBinding: vi.fn(),
    createComputeShader: vi.fn(),
    createComputeBindingSet: vi.fn(),
    createComputeDispatch: vi.fn(),
    createComputeIndirectDispatch: vi.fn(),
    createComputeTask: vi.fn(),
    addComputeDispatch: vi.fn(),
    submitComputeTasks: vi.fn(),
    disposeComputeBindingSet: vi.fn(),
    disposeComputeShader: vi.fn(),
}));

vi.mock("babylon-lite", async (importActual) => {
    const actual = await importActual<typeof import("babylon-lite")>();
    return { ...actual, ...mocks };
});

import { StorageBuffer } from "../src/buffers/storage-buffer";
import { ComputeShader } from "../src/compute/compute-shader";
import type { WebGPUEngine } from "../src/engine/engine";
import { LiteCompatError } from "../src/error";
import { UniformBuffer } from "../src/materials/uniform-buffer";

const engine = { _lite: { id: "engine" } } as unknown as WebGPUEngine;

beforeEach(() => {
    vi.clearAllMocks();
    mocks.createStorageBuffer.mockReturnValue({ byteLength: 64, _writable: true });
    mocks.readStorageBufferAfterFrame.mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer);
    mocks.createUniformBuffer.mockReturnValue({ byteLength: 16 });
    mocks.computeStorageBufferBinding.mockImplementation((name, options) => ({ name, options }));
    mocks.computeUniformBufferBinding.mockImplementation((name, options) => ({ name, options }));
    mocks.createComputeShader.mockReturnValue({ name: "lite-shader" });
    mocks.createComputeBindingSet.mockReturnValue({ name: "lite-bindings" });
    mocks.createComputeDispatch.mockReturnValue({ name: "direct-dispatch" });
    mocks.createComputeIndirectDispatch.mockReturnValue({ name: "indirect-dispatch" });
    mocks.createComputeTask.mockReturnValue({ record: vi.fn(), dispose: vi.fn() });
});

describe("StorageBuffer forwarding", () => {
    it("maps Babylon.js defaults and role flags to Lite", () => {
        const buffer = new StorageBuffer(engine, 64);
        expect(mocks.createStorageBuffer).toHaveBeenCalledWith(engine._lite, 64, {
            label: undefined,
            writable: true,
            vertex: false,
            index: false,
            indirect: false,
        });
        expect(buffer.getBuffer()).toBe(mocks.createStorageBuffer.mock.results[0]!.value);

        new StorageBuffer(engine, 32, 1 | 8 | 16 | 64, "roles");
        expect(mocks.createStorageBuffer).toHaveBeenLastCalledWith(engine._lite, 32, {
            label: "roles",
            writable: true,
            vertex: true,
            index: true,
            indirect: true,
        });
    });

    it("forwards update, clear, read, target-copy, and disposal", async () => {
        const buffer = new StorageBuffer(engine, 64);
        const lite = buffer.getBuffer();
        buffer.update([1, 2], 4);
        const updateBytes = mocks.updateStorageBufferRange.mock.calls[0]![2] as Uint8Array;
        expect(Array.from(new Float32Array(updateBytes.buffer, updateBytes.byteOffset, 2))).toEqual([1, 2]);
        expect(mocks.updateStorageBufferRange.mock.calls[0]!.slice(0, 2)).toEqual([engine._lite, buffer.getBuffer()]);
        expect(mocks.updateStorageBufferRange.mock.calls[0]![3]).toBe(4);

        buffer.clear(8, 12);
        expect(mocks.clearStorageBuffer).toHaveBeenCalledWith(engine._lite, buffer.getBuffer(), 8, 12);

        await expect(buffer.read(4, 4)).resolves.toEqual(new Uint8Array([1, 2, 3, 4]));
        expect(mocks.readStorageBufferAfterFrame).toHaveBeenCalledWith(buffer.getBuffer(), 4, 4, false);
        const target = new Uint16Array(4);
        await expect(buffer.read(0, 4, target, true)).resolves.toBe(target);
        expect(mocks.readStorageBufferAfterFrame).toHaveBeenLastCalledWith(buffer.getBuffer(), 0, 4, true);
        expect(new Uint8Array(target.buffer).subarray(0, 4)).toEqual(new Uint8Array([1, 2, 3, 4]));

        buffer.dispose();
        expect(mocks.disposeStorageBuffer).toHaveBeenCalledWith(lite);
        expect(buffer.getBuffer()).toBeNull();
        buffer.update(new Uint32Array([1]));
        expect(mocks.updateStorageBufferRange).toHaveBeenCalledTimes(1);
    });

    it("rejects combined storage and uniform usage at the structural boundary", () => {
        expect(() => new StorageBuffer(engine, 16, 4)).toThrow(LiteCompatError);
        expect(mocks.createStorageBuffer).not.toHaveBeenCalled();
    });

    it("keeps BJS copy flags separate from shader storage access", async () => {
        const readable = new StorageBuffer(engine, 16, 1);
        await expect(readable.read(0, 4)).resolves.toEqual(new Uint8Array([1, 2, 3, 4]));
        expect(() => readable.update(new Uint32Array([1]))).toThrow(/BUFFER_CREATIONFLAG_WRITE/);

        const writable = new StorageBuffer(engine, 16, 2);
        writable.update(new Uint32Array([1]));
        await expect(writable.read(0, 4)).rejects.toThrow(/BUFFER_CREATIONFLAG_READ/);
    });
});

describe("UniformBuffer compute subset", () => {
    it("preserves std140 alignment and forwards creation and upload", () => {
        const buffer = new UniformBuffer(engine, [], false, "params");
        buffer.addUniform("scalar", 1);
        buffer.addFloat3("direction", 2, 3, 4);
        buffer.create();
        const initial = Array.from(mocks.createUniformBuffer.mock.calls[0]![1] as Float32Array);
        buffer.updateFloat("scalar", 1);
        buffer.update();

        expect(mocks.createUniformBuffer).toHaveBeenCalledTimes(1);
        expect(initial).toEqual([0, 0, 0, 0, 2, 3, 4, 0]);
        expect(mocks.createUniformBuffer.mock.calls[0]![2]).toEqual({ label: "params_UniformList:scalar,direction" });
        const uploaded = mocks.updateUniformBuffer.mock.calls[0]![2] as Float32Array;
        expect(Array.from(uploaded)).toEqual([1, 0, 0, 0, 2, 3, 4, 0]);
        expect(buffer.getUniformNames()).toEqual(["scalar", "direction"]);
        expect(buffer.isSync).toBe(true);
    });

    it("bit-casts integer updates and forwards disposal", () => {
        const buffer = new UniformBuffer(engine);
        buffer.addUniform("value", 1);
        buffer.updateInt("value", -2);
        buffer.update();

        const uploaded = mocks.updateUniformBuffer.mock.calls[0]![2] as Float32Array;
        expect(new Int32Array(uploaded.buffer)[0]).toBe(-2);
        buffer.dispose();
        expect(mocks.disposeUniformBuffer).toHaveBeenCalledWith(mocks.createUniformBuffer.mock.results[0]!.value);
    });

    it("always uploads dynamic buffers, including direct getData mutations", () => {
        const buffer = new UniformBuffer(engine, [1, 2, 3, 4], true);
        buffer.create();
        buffer.update();
        buffer.getData()[0] = 9;
        buffer.update();

        expect(mocks.updateUniformBuffer).toHaveBeenCalledTimes(2);
        expect((mocks.updateUniformBuffer.mock.calls[1]![2] as Float32Array)[0]).toBe(9);
    });

    it("does not dirty a static buffer when a fractional value rounds to the stored float32", () => {
        const buffer = new UniformBuffer(engine);
        buffer.addUniform("fraction", 1);
        buffer.updateFloat("fraction", 0.1);
        buffer.update();
        buffer.updateFloat("fraction", 0.1);
        buffer.update();

        expect(mocks.updateUniformBuffer).toHaveBeenCalledTimes(1);
    });
});

describe("ComputeShader forwarding", () => {
    it("maps BJS buffer bindings and submits a direct Lite compute task", () => {
        const shader = new ComputeShader(
            "update",
            engine,
            { computeSource: "@compute @workgroup_size(1) fn main() {}" },
            {
                bindingsMapping: {
                    uniforms: { group: 0, binding: 0 },
                    values: { group: 0, binding: 1 },
                },
            }
        );
        const uniform = { byteLength: 16 };
        const storage = { byteLength: 64, _writable: true };
        shader.setUniformBuffer("uniforms", uniform as never);
        shader.setStorageBuffer("values", storage as never);
        const compiled = vi.fn();
        shader.onCompiled = compiled;

        expect(shader.dispatch(4)).toBe(true);
        expect(mocks.computeUniformBufferBinding).toHaveBeenCalledWith("uniforms", { group: 0, binding: 0 });
        expect(mocks.computeStorageBufferBinding).toHaveBeenCalledWith("values", { group: 0, binding: 1, access: "read" });
        expect(mocks.createComputeShader).toHaveBeenCalledWith(engine._lite, {
            name: "update",
            computeSource: "@compute @workgroup_size(1) fn main() {}",
            entryPoint: "main",
            bindings: [
                { name: "uniforms", options: { group: 0, binding: 0 } },
                { name: "values", options: { group: 0, binding: 1, access: "read" } },
            ],
            automaticLayout: true,
        });

        expect(mocks.createComputeBindingSet).toHaveBeenCalledWith({ name: "lite-shader" }, { uniforms: uniform, values: storage });
        expect(mocks.createComputeDispatch).toHaveBeenCalledWith({ name: "lite-shader" }, { name: "lite-bindings" }, { size: { x: 4, y: 1, z: 1 } });
        expect(mocks.submitComputeTasks).toHaveBeenCalledTimes(1);
        expect(compiled).toHaveBeenCalledWith({ name: "lite-shader" });

        expect(shader.dispatch(2, 3, 4)).toBe(true);
        expect(mocks.createComputeShader).toHaveBeenCalledTimes(1);
        expect(mocks.createComputeBindingSet).toHaveBeenCalledTimes(1);
        expect(mocks.createComputeDispatch).toHaveBeenLastCalledWith({ name: "lite-shader" }, { name: "lite-bindings" }, { size: { x: 2, y: 3, z: 4 } });
        expect(compiled).toHaveBeenCalledTimes(1);
    });

    it("uses automatic shader-derived layouts without parsing WGSL storage declarations", () => {
        const shader = new ComputeShader(
            "read",
            engine,
            {
                computeSource: "@group(0) @binding(0) var<storage, read> values: array<u32>; @compute @workgroup_size(1) fn main() {}",
            },
            { bindingsMapping: { values: { group: 0, binding: 0 } } }
        );
        shader.setStorageBuffer("values", { byteLength: 64, _writable: true } as never);

        expect(shader.dispatch(1)).toBe(true);
        expect(mocks.computeStorageBufferBinding).toHaveBeenCalledWith("values", { group: 0, binding: 0, access: "read" });
        expect(mocks.createComputeShader).toHaveBeenCalledWith(engine._lite, expect.objectContaining({ automaticLayout: true }));
    });

    it("keeps the compiled shader while rebuilding bindings and ignores identical assignments", () => {
        const shader = new ComputeShader("stable", engine, { computeSource: "source" }, { bindingsMapping: { values: { group: 0, binding: 0 } } });
        const first = { byteLength: 16, _writable: true };
        const second = { byteLength: 16, _writable: true };
        shader.setStorageBuffer("values", first as never);
        shader.dispatch(1);
        shader.setStorageBuffer("values", first as never);
        shader.dispatch(1);
        expect(mocks.createComputeBindingSet).toHaveBeenCalledTimes(1);

        shader.setStorageBuffer("values", second as never);
        shader.dispatch(1);
        expect(mocks.disposeComputeBindingSet).toHaveBeenCalledTimes(1);
        expect(mocks.createComputeBindingSet).toHaveBeenCalledTimes(2);
        expect(mocks.createComputeShader).toHaveBeenCalledTimes(1);
        expect(mocks.disposeComputeShader).not.toHaveBeenCalled();
    });

    it("defers changed binding reconstruction while fastMode is enabled", () => {
        const shader = new ComputeShader("fast", engine, { computeSource: "source" }, { bindingsMapping: { values: { group: 0, binding: 0 } } });
        shader.setStorageBuffer("values", { byteLength: 16, _writable: true } as never);
        shader.dispatch(1);
        shader.fastMode = true;
        shader.setStorageBuffer("values", { byteLength: 16, _writable: true } as never);
        shader.dispatch(1);
        expect(mocks.createComputeBindingSet).toHaveBeenCalledTimes(1);

        shader.triggerContextRebuild = true;
        shader.dispatch(1);
        expect(mocks.createComputeBindingSet).toHaveBeenCalledTimes(2);
        expect(mocks.createComputeShader).toHaveBeenCalledTimes(1);
    });

    it("compiles and invokes onCompiled from isReady before submission", () => {
        const shader = new ComputeShader("ready", engine, { computeSource: "source" });
        const compiled = vi.fn();
        shader.onCompiled = compiled;

        expect(shader.isReady()).toBe(true);
        expect(compiled).toHaveBeenCalledWith({ name: "lite-shader" });
        expect(mocks.submitComputeTasks).not.toHaveBeenCalled();
    });

    it("forwards indirect dispatch and preserves its default byte offset", () => {
        const shader = new ComputeShader("indirect", engine, { computeSource: "@compute @workgroup_size(1) fn main() {}" }, { bindingsMapping: {} });
        const indirect = { byteLength: 12, _writable: true };

        expect(shader.dispatchIndirect(indirect as never)).toBe(true);
        expect(mocks.createComputeIndirectDispatch).toHaveBeenCalledWith({ name: "lite-shader" }, { name: "lite-bindings" }, { buffer: indirect, byteOffset: 0 });
    });

    it("preserves option defaults and reports structurally blocked source/texture paths", () => {
        const shader = new ComputeShader("defaults", engine, { computeSource: "source" });
        expect(shader.options).toEqual({ bindingsMapping: {}, defines: [], entryPoint: "main" });
        expect(shader.getClassName()).toBe("ComputeShader");

        expect(() => new ComputeShader("stored", engine, "storedShader")).toThrow(LiteCompatError);
        expect(() => shader.setTexture("texture", {} as never)).toThrow(/asynchronous createComputeTextureResource/);
    });

    it("exposes ComputeShader.Parse before registration", () => {
        const parsed = ComputeShader.Parse(
            {
                name: "parsed",
                shaderPath: { computeSource: "source" },
                options: { bindingsMapping: {} },
            },
            { getEngine: () => engine },
            ""
        );
        expect(parsed).toBeInstanceOf(ComputeShader);
        expect(parsed.name).toBe("parsed");
    });

    it("reports Lite's active-frame submission boundary explicitly", () => {
        mocks.submitComputeTasks.mockImplementationOnce(() => {
            throw new Error("submitComputeTasks cannot run while a frame is being recorded.");
        });
        const shader = new ComputeShader("frame", engine, { computeSource: "source" });
        expect(() => shader.dispatch(1)).toThrow(/no engine-level hook equivalent/);
    });
});
