import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMeshLoD } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod.js";
import { _recoverMeshLoDAsset } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-runtime.js";
import { _setMeshLoDPageDecoder } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-page-decoder.js";
import { clearMeshLoDCpuPageCache } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-cache.js";
import type { MeshoptDecoderModule } from "../../../../packages/babylon-lite/src/loader-gltf/meshopt-decode.js";
import { buildMinimalContainer } from "../../unit/mesh-lod/fixtures/mlod-fixture.js";
import { createFillDecoder, createMockDevice, createMockEngine, type MockDevice } from "../../unit/mesh-lod/fixtures/gpu-mock.js";

function source(): ArrayBuffer {
    return buildMinimalContainer().bytes.buffer as ArrayBuffer;
}

beforeEach(() => {
    _setMeshLoDPageDecoder(createFillDecoder().decoder);
});
afterEach(() => {
    _setMeshLoDPageDecoder(null);
    vi.restoreAllMocks();
});

describe("MeshLoD arena cleanup", () => {
    it("destroys the arena when pinned decoding fails", async () => {
        const decoder: MeshoptDecoderModule = {
            ready: Promise.resolve(),
            decodeGltfBuffer() {
                throw new Error("decoder failed");
            },
        };
        _setMeshLoDPageDecoder(decoder);
        const { engine, device } = createMockEngine();
        await expect(loadMeshLoD(engine, source())).rejects.toMatchObject({ code: "MLOD_DECODER_FAILURE" });
        expect(device.buffers).toHaveLength(1);
        expect(device.buffers[0]!.destroyed).toBe(true);
    });

    it("destroys the arena when loading is aborted during pinned decoding", async () => {
        const controller = new AbortController();
        const fill = createFillDecoder().decoder;
        _setMeshLoDPageDecoder({
            ready: Promise.resolve(),
            decodeGltfBuffer(target, count, size, encoded, mode, filter) {
                fill.decodeGltfBuffer(target, count, size, encoded, mode, filter);
                controller.abort();
            },
        });
        const { engine, device } = createMockEngine();
        await expect(loadMeshLoD(engine, source(), { signal: controller.signal })).rejects.toMatchObject({ code: "MLOD_ABORTED" });
        expect(device.buffers).toHaveLength(1);
        expect(device.buffers[0]!.destroyed).toBe(true);
    });

    it("destroys an incomplete recovery arena when pinned bytes are unavailable", async () => {
        const { engine } = createMockEngine();
        const asset = await loadMeshLoD(engine, source());
        const oldArena = asset._runtime.gpu.arena.buffer;
        clearMeshLoDCpuPageCache(asset._runtime.cpuPageCache);
        const replacement = createMockDevice();
        (engine as unknown as { _device: MockDevice })._device = replacement;

        expect(() => _recoverMeshLoDAsset(engine, asset._runtime)).toThrowError(expect.objectContaining({ code: "MLOD_DEVICE_RECOVERY" }));
        expect(replacement.buffers).toHaveLength(1);
        expect(replacement.buffers[0]!.destroyed).toBe(true);
        expect(asset._runtime.gpu.arena.buffer).toBe(oldArena);
    });

    it("destroys a partially allocated recovery arena after upload failure and permits retry", async () => {
        const { engine } = createMockEngine();
        const asset = await loadMeshLoD(engine, source());
        const oldArena = asset._runtime.gpu.arena.buffer;
        const replacement = createMockDevice();
        const write = vi.spyOn(replacement.queue, "writeBuffer").mockImplementation(() => {
            throw new Error("GPU upload failed");
        });
        (engine as unknown as { _device: MockDevice })._device = replacement;

        expect(() => _recoverMeshLoDAsset(engine, asset._runtime)).toThrowError(expect.objectContaining({ code: "MLOD_DEVICE_RECOVERY", pageId: 0 }));
        expect(replacement.buffers).toHaveLength(1);
        expect(replacement.buffers[0]!.destroyed).toBe(true);
        expect(asset._runtime.gpu.arena.buffer).toBe(oldArena);

        write.mockRestore();
        _recoverMeshLoDAsset(engine, asset._runtime);
        expect(asset._runtime.gpu.arena.buffer).toBe(replacement.buffers[1]);
        expect(replacement.buffers[1]!.destroyed).toBe(false);
    });
});
