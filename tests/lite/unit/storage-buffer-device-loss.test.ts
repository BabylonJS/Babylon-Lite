import { describe, expect, it, vi } from "vitest";

import type { DeviceLostRecoveryState } from "../../../packages/babylon-lite/src/engine/device-lost-recovery";
import { runDeviceLostRecovery } from "../../../packages/babylon-lite/src/engine/device-lost-recovery-run";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { _rebuildMeshes } from "../../../packages/babylon-lite/src/engine/recovery-rebuild";
import { disposeMeshGpu } from "../../../packages/babylon-lite/src/mesh/mesh-dispose";
import { createMeshFromStorageBuffer } from "../../../packages/babylon-lite/src/mesh/mesh-from-storage";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { createStorageBuffer, _rebuildStorageBuffers } from "../../../packages/babylon-lite/src/resource/storage-buffer";

const BU = globalThis.GPUBufferUsage;

function makeDevice() {
    const make = (d: GPUBufferDescriptor) => {
        const backing = new ArrayBuffer(Number(d.size));
        return {
            label: d.label,
            usage: Number(d.usage),
            size: Number(d.size),
            getMappedRange: () => backing,
            unmap: vi.fn(),
            destroy: vi.fn(),
        } as unknown as GPUBuffer;
    };
    return { createBuffer: vi.fn(make), queue: { writeBuffer: vi.fn() }, limits: {} } as unknown as GPUDevice;
}

function makeEngine() {
    return { _device: makeDevice() } as unknown as EngineContext;
}

/** Swap in a replacement device, as device-lost recovery does, and rebuild. */
function loseDevice(engine: EngineContext): void {
    (engine as { _device: GPUDevice })._device = makeDevice();
    _rebuildStorageBuffers(engine);
}

describe("storage buffers survive a device loss", () => {
    it("keeps every usage flag the allocation was created with", () => {
        const engine = makeEngine();
        const slab = createStorageBuffer(engine, 256, { writable: true, vertex: true, index: true, label: "slab" });
        const before = (slab._buffer as unknown as { usage: number }).usage;

        loseDevice(engine);
        const after = (slab._buffer as unknown as { usage: number }).usage;

        // The regression: the rebuild recomputed usage as STORAGE|VERTEX only, so an
        // allocation shared as a topology could no longer bind as an index buffer, and a
        // compute target could no longer be copied out of — but only after a device loss,
        // which is exactly when nobody is looking.
        for (const [name, flag] of [
            ["STORAGE", BU.STORAGE],
            ["VERTEX", BU.VERTEX],
            ["INDEX", BU.INDEX],
            ["COPY_SRC", BU.COPY_SRC],
        ] as const) {
            expect(before & flag, `${name} at creation`).toBe(flag);
            expect(after & flag, `${name} after rebuild`).toBe(flag);
        }
    });

    it("does not add usages an allocation never asked for", () => {
        const engine = makeEngine();
        const plain = createStorageBuffer(engine, 64);
        loseDevice(engine);
        const after = (plain._buffer as unknown as { usage: number }).usage;
        expect(after & BU.VERTEX).toBe(0);
        expect(after & BU.INDEX).toBe(0);
        expect(after & BU.COPY_SRC).toBe(0);
    });

    it("re-points a slab-backed mesh at the rebuilt allocation", () => {
        const engine = makeEngine();
        const slab = createStorageBuffer(engine, 8 * 16 * 4, { writable: true, vertex: true });
        const topology = createStorageBuffer(engine, 64, { index: true });
        const mesh = createMeshFromStorageBuffer(engine, "chunk", {
            storage: slab,
            indices: topology,
            indexCount: 6,
            indexFormat: "uint32",
            vertexCount: 8,
            arrayStride: 16,
        });

        const deadVertex = mesh._gpu.positionBuffer;
        const deadIndex = mesh._gpu.indexBuffer;
        loseDevice(engine);

        // Without this the mesh keeps drawing from buffers that died with the old device.
        expect(mesh._gpu.positionBuffer).not.toBe(deadVertex);
        expect(mesh._gpu.positionBuffer).toBe(slab._buffer);
        expect(mesh._gpu.normalBuffer).toBe(slab._buffer);
        expect(mesh._gpu.uvBuffer).toBe(slab._buffer);
        expect(mesh._gpu.indexBuffer).not.toBe(deadIndex);
        expect(mesh._gpu.indexBuffer).toBe(topology._buffer);
    });

    it("uploads an owned index topology again on the replacement device", () => {
        const engine = makeEngine();
        const slab = createStorageBuffer(engine, 8 * 16 * 4, { writable: true, vertex: true });
        const mesh = createMeshFromStorageBuffer(engine, "chunk", {
            storage: slab,
            indices: new Uint16Array([0, 1, 2, 2, 1, 3]),
            vertexCount: 8,
            arrayStride: 16,
        });
        const deadIndex = mesh._gpu.indexBuffer;

        loseDevice(engine);

        // The regression: this handle was left alone on the assumption that the mesh's own
        // recovery restores it. It does not -- `_rebuildMeshes` skips any mesh without CPU
        // positions, which is every storage-backed mesh -- so it kept the lost device's buffer.
        const rebuilt = mesh._gpu.indexBuffer as unknown as { usage: number; size: number };
        expect(mesh._gpu.indexBuffer).not.toBe(deadIndex);
        expect(rebuilt.usage & BU.INDEX).toBe(BU.INDEX);
        expect(rebuilt.size).toBe(12);
        expect(mesh._gpu.indexFormat).toBe("uint16");
    });

    it("re-points every optional stream the slab advertises", () => {
        const engine = makeEngine();
        const slab = createStorageBuffer(engine, 4 * 48, { writable: true, vertex: true });
        const mesh = createMeshFromStorageBuffer(engine, "chunk", {
            storage: slab,
            indices: new Uint32Array([0, 1, 2, 2, 1, 3]),
            vertexCount: 4,
            arrayStride: 48,
            attributeOffsets: { position: 0, normal: 12, tangent: 24, uv: 28, uv2: 36, color: 40 },
        });
        const dead = mesh._gpu.positionBuffer;
        expect(mesh._gpu.tangentBuffer).toBe(dead);
        expect(mesh._gpu.uv2Buffer).toBe(dead);
        expect(mesh._gpu.colorBuffer).toBe(dead);

        loseDevice(engine);

        // Position, normal and uv used to be the only fields re-pointed, so tangent, uv2 and
        // color stayed bound to a buffer from the lost device.
        for (const field of ["positionBuffer", "normalBuffer", "uvBuffer", "tangentBuffer", "uv2Buffer", "colorBuffer"] as const) {
            expect(mesh._gpu[field], field).toBe(slab._buffer);
        }
    });

    it("leaves streams the slab does not advertise unbound", () => {
        const engine = makeEngine();
        const slab = createStorageBuffer(engine, 4 * 16, { writable: true, vertex: true });
        const mesh = createMeshFromStorageBuffer(engine, "chunk", {
            storage: slab,
            indices: new Uint32Array([0, 1, 2]),
            vertexCount: 4,
            arrayStride: 16,
        });

        loseDevice(engine);

        expect(mesh._gpu.tangentBuffer).toBeNull();
        expect(mesh._gpu.uv2Buffer).toBeNull();
        expect(mesh._gpu.colorBuffer).toBeNull();
    });

    it("does not upload a topology for a mesh disposed before the loss", () => {
        const engine = makeEngine();
        const slab = createStorageBuffer(engine, 8 * 16 * 4, { writable: true, vertex: true });
        const mesh = createMeshFromStorageBuffer(engine, "chunk", {
            storage: slab,
            indices: new Uint32Array([0, 1, 2, 2, 1, 3]),
            vertexCount: 8,
            arrayStride: 16,
        });
        disposeMeshGpu(mesh);
        const disposedIndex = mesh._gpu.indexBuffer;

        loseDevice(engine);

        // Recreating it would allocate a GPU buffer nothing will ever destroy.
        expect(mesh._gpu.indexBuffer).toBe(disposedIndex);
        expect(engine._device.createBuffer).not.toHaveBeenCalledWith(expect.objectContaining({ usage: BU.INDEX }));
    });
});

describe("storage-backed meshes through a full device-loss recovery", () => {
    function recoveryDevice(): GPUDevice {
        return Object.assign(makeDevice(), {
            features: new Set<GPUFeatureName>(),
            lost: new Promise<GPUDeviceLostInfo>(() => undefined),
        });
    }

    it("draws from buffers on the new device once scene mesh recovery has also run", async () => {
        const engine = {
            _device: recoveryDevice(),
            surfaces: [],
            _animFrameId: 0,
            _renderFn: null,
            _retirements: null,
        } as unknown as EngineContext;
        const slab = createStorageBuffer(engine, 4 * 48, { writable: true, vertex: true });
        const mesh = createMeshFromStorageBuffer(engine, "chunk", {
            storage: slab,
            indices: new Uint32Array([0, 1, 2, 2, 1, 3]),
            vertexCount: 4,
            arrayStride: 48,
            attributeOffsets: { position: 0, normal: 12, tangent: 24, uv: 28, uv2: 36, color: 40 },
        });
        const lostIndex = mesh._gpu.indexBuffer;

        const replacement = recoveryDevice();
        vi.stubGlobal("navigator", {
            gpu: { requestAdapter: vi.fn(async () => ({ features: new Set<GPUFeatureName>(), requestDevice: vi.fn(async () => replacement) })) },
        });
        const state = { _requiredFeatures: [], _textures: new Set() } as unknown as DeviceLostRecoveryState;
        try {
            // The real sequence: replacement device, storage rebuild (and its observer), then the
            // per-context handlers. Scene recovery's `_rebuildMeshes` walks the same mesh after
            // that and must leave the recovered handles in place.
            await runDeviceLostRecovery(engine, state, []);
            await _rebuildMeshes(engine, { meshes: [mesh] } as unknown as SceneContext);
        } finally {
            vi.unstubAllGlobals();
        }

        const madeOnReplacement = vi.mocked(replacement.createBuffer).mock.results.map((r) => r.value as GPUBuffer);
        expect(engine._device).toBe(replacement);
        expect(madeOnReplacement).toContain(slab._buffer);
        expect(mesh._gpu.indexBuffer).not.toBe(lostIndex);
        expect(madeOnReplacement).toContain(mesh._gpu.indexBuffer);
        for (const field of ["positionBuffer", "normalBuffer", "uvBuffer", "tangentBuffer", "uv2Buffer", "colorBuffer"] as const) {
            expect(madeOnReplacement, field).toContain(mesh._gpu[field]);
        }
    });
});
