/** Minimal WebGPU device + meshopt-decoder mocks for MeshLoD loader tests.
 *
 *  The MeshLoD loader (Task 4.2 onward) decodes pinned pages and uploads them into a
 *  GPU arena, so Node tests need a stand-in device and decoder. The mock device
 *  records every `createBuffer`/`writeBuffer` so tests can assert the pinned prefix
 *  layout; the fill decoder produces in-range indices without WASM. */

import type { EngineContext } from "../../../../../packages/babylon-lite/src/engine/engine.js";
import type { MeshoptDecoderModule } from "../../../../../packages/babylon-lite/src/loader-gltf/meshopt-decode.js";

export interface MockBuffer {
    readonly label?: string;
    readonly size: number;
    readonly usage: number;
    destroyed: boolean;
    destroy(): void;
}

export interface BufferWrite {
    readonly buffer: MockBuffer;
    readonly offset: number;
    readonly byteLength: number;
}

export interface MockDevice {
    readonly limits: { maxStorageBufferBindingSize: number; maxBufferSize: number };
    readonly buffers: MockBuffer[];
    readonly writes: BufferWrite[];
    createBuffer(desc: { label?: string; size: number; usage: number }): MockBuffer;
    createTexture(desc: unknown): { createView(): object; destroy(): void };
    createSampler(desc?: unknown): object;
    createShaderModule(desc: { code: string; label?: string }): { code: string };
    createBindGroupLayout(desc: unknown): object;
    createBindGroup(desc: unknown): object;
    createPipelineLayout(desc: unknown): object;
    createRenderPipeline(desc: unknown): object;
    createComputePipeline(desc: unknown): { getBindGroupLayout(index: number): object };
    readonly queue: {
        writeBuffer(buffer: MockBuffer, offset: number, data: ArrayBuffer | ArrayBufferView, dataOffset?: number, size?: number): void;
        writeTexture(...args: unknown[]): void;
    };
}

/** Create a mock GPU device. `limitBytes` overrides the reported storage/buffer
 *  limits so device-limit boundaries can be exercised. */
export function createMockDevice(limitBytes = 1024 * 1024 * 1024): MockDevice {
    const buffers: MockBuffer[] = [];
    const writes: BufferWrite[] = [];
    const device: MockDevice = {
        limits: { maxStorageBufferBindingSize: limitBytes, maxBufferSize: limitBytes },
        buffers,
        writes,
        createBuffer(desc) {
            const buffer: MockBuffer = {
                label: desc.label,
                size: desc.size,
                usage: desc.usage,
                destroyed: false,
                destroy() {
                    this.destroyed = true;
                },
            };
            buffers.push(buffer);
            return buffer;
        },
        createTexture() {
            return { createView: () => ({}), destroy: () => {} };
        },
        createSampler() {
            return {};
        },
        createShaderModule(desc) {
            return { code: desc.code };
        },
        createBindGroupLayout() {
            return {};
        },
        createBindGroup() {
            return {};
        },
        createPipelineLayout() {
            return {};
        },
        createRenderPipeline() {
            return {};
        },
        createComputePipeline() {
            return { getBindGroupLayout: () => ({}) };
        },
        queue: {
            writeBuffer(buffer, offset, data, dataOffset = 0, size) {
                const byteLength = size ?? (ArrayBuffer.isView(data) ? data.byteLength - dataOffset : (data as ArrayBuffer).byteLength - dataOffset);
                writes.push({ buffer, offset, byteLength });
            },
            writeTexture() {},
        },
    };
    return device;
}

/** A mock render-pass encoder that records the draw commands it receives. */
export interface MockRenderPass {
    readonly setBindGroups: { index: number }[];
    readonly indirectDraws: { buffer: MockBuffer; offset: number }[];
    setBindGroup(index: number, group: unknown): void;
    drawIndirect(buffer: MockBuffer, offset: number): void;
}

export function createMockRenderPass(): MockRenderPass {
    const setBindGroups: { index: number }[] = [];
    const indirectDraws: { buffer: MockBuffer; offset: number }[] = [];
    return {
        setBindGroups,
        indirectDraws,
        setBindGroup(index) {
            setBindGroups.push({ index });
        },
        drawIndirect(buffer, offset) {
            indirectDraws.push({ buffer, offset });
        },
    };
}

/** A recorded compute dispatch (direct or indirect). */
export interface MockComputeDispatch {
    readonly kind: "direct" | "indirect";
    readonly workgroups?: number;
    readonly indirectBuffer?: MockBuffer;
    readonly indirectOffset?: number;
}

/** A mock compute-pass encoder that records dispatch commands. */
export interface MockComputePass {
    readonly dispatches: MockComputeDispatch[];
    readonly setBindGroups: { index: number }[];
    setPipeline(pipeline: unknown): void;
    setBindGroup(index: number, group: unknown): void;
    dispatchWorkgroups(x: number): void;
    dispatchWorkgroupsIndirect(buffer: MockBuffer, offset: number): void;
    end(): void;
}

export interface BufferCopy {
    readonly src: MockBuffer;
    readonly srcOffset: number;
    readonly dst: MockBuffer;
    readonly dstOffset: number;
    readonly size: number;
}

export interface BufferClear {
    readonly buffer: MockBuffer;
    readonly offset: number;
    readonly size?: number;
}

/** A mock command encoder recording buffer copies/clears and compute passes. */
export interface MockEncoder {
    readonly copies: BufferCopy[];
    readonly clears: BufferClear[];
    readonly computePasses: MockComputePass[];
    copyBufferToBuffer(src: MockBuffer, srcOffset: number, dst: MockBuffer, dstOffset: number, size: number): void;
    clearBuffer(buffer: MockBuffer, offset?: number, size?: number): void;
    beginComputePass(): MockComputePass;
}

export function createMockEncoder(): MockEncoder {
    const copies: BufferCopy[] = [];
    const clears: BufferClear[] = [];
    const computePasses: MockComputePass[] = [];
    return {
        copies,
        clears,
        computePasses,
        copyBufferToBuffer(src, srcOffset, dst, dstOffset, size) {
            copies.push({ src, srcOffset, dst, dstOffset, size });
        },
        clearBuffer(buffer, offset = 0, size) {
            clears.push({ buffer, offset, size });
        },
        beginComputePass() {
            const dispatches: MockComputeDispatch[] = [];
            const setBindGroups: { index: number }[] = [];
            const pass: MockComputePass = {
                dispatches,
                setBindGroups,
                setPipeline() {},
                setBindGroup(index) {
                    setBindGroups.push({ index });
                },
                dispatchWorkgroups(x) {
                    dispatches.push({ kind: "direct", workgroups: x });
                },
                dispatchWorkgroupsIndirect(indirectBuffer, indirectOffset) {
                    dispatches.push({ kind: "indirect", indirectBuffer, indirectOffset });
                },
                end() {},
            };
            computePasses.push(pass);
            return pass;
        },
    };
}

/** Wrap a mock device as an `EngineContext` for the loader. Attaches a recording
 *  command encoder as `_currentEncoder` so make-before-break growth and compute
 *  submission can be asserted. */
export function createMockEngine(device: MockDevice = createMockDevice()): { engine: EngineContext; device: MockDevice; encoder: MockEncoder } {
    const encoder = createMockEncoder();
    const engine = { _device: device, _currentEncoder: encoder, _retirements: null, _renderingContexts: [] } as unknown as EngineContext;
    return { engine, device, encoder };
}

/** A decoder that fills decoded vertex bytes with zeros and index bytes with a
 *  valid in-range pattern. Records the modes it was asked to decode. */
export function createFillDecoder(): { decoder: MeshoptDecoderModule; modes: string[] } {
    const modes: string[] = [];
    const decoder: MeshoptDecoderModule = {
        ready: Promise.resolve(),
        decodeGltfBuffer(target, count, size, _source, mode) {
            modes.push(mode);
            if (mode === "TRIANGLES") {
                const view = new DataView(target.buffer, target.byteOffset, target.byteLength);
                for (let i = 0; i < count; i++) {
                    view.setUint16(i * size, i % 3, true); // always in range for a >=3-vertex page
                }
            }
        },
    };
    return { decoder, modes };
}
