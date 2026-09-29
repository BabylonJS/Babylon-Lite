/** MeshLoD loader integration tests (Task 4.2).
 *
 *  Drive the full public `loadMeshLoD` path through pinned-page decode and GPU
 *  upload using a mock device + fill decoder (no WASM). Cover promise timing vs.
 *  pinned/fine fetches, the minimum-budget and device-limit boundaries, pinned
 *  decode/integrity failure, and the resolved diagnostics/residency state. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMeshLoD } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod.js";
import { isMeshLoDError } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-errors.js";
import { _setMeshLoDPageDecoder } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-page-decoder.js";
import { parseMeshLoDContainer } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-format.js";
import type { MeshoptDecoderModule } from "../../../../packages/babylon-lite/src/loader-gltf/meshopt-decode.js";
import { createFillDecoder, createMockDevice, createMockEngine } from "../../unit/mesh-lod/fixtures/gpu-mock.js";

const STATUE = fileURLToPath(new URL("../../../../lab/public/mesh-lod/harvard-yenching_institute_statue.mesh000.prim000.mlod", import.meta.url));

function statueBytes(): Uint8Array {
    return new Uint8Array(readFileSync(STATUE));
}

function sourceBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.slice().buffer as ArrayBuffer;
}

interface Server {
    fetch: typeof globalThis.fetch;
    calls: number;
}

function rangeServer(file: Uint8Array): Server {
    const server: Server = {
        calls: 0,
        fetch: (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
            server.calls += 1;
            const range = new Headers(init?.headers).get("Range");
            if (!range) {
                return new Response(sourceBuffer(file), { status: 200, headers: { "Content-Length": String(file.length) } });
            }
            const match = /^bytes=(\d+)-(\d+)$/.exec(range)!;
            const start = Number(match[1]);
            const end = Math.min(Number(match[2]), file.length - 1);
            const body = file.subarray(start, end + 1);
            return new Response(sourceBuffer(body), { status: 206, headers: { "Content-Range": `bytes ${start}-${end}/${file.length}`, "Content-Length": String(body.length) } });
        }) as typeof globalThis.fetch,
    };
    return server;
}

beforeEach(() => {
    _setMeshLoDPageDecoder(createFillDecoder().decoder);
});
afterEach(() => {
    _setMeshLoDPageDecoder(null);
});

describe("loadMeshLoD — pinned residency", () => {
    it("resolves with only pinned pages resident (no fine decode/upload)", async () => {
        const { engine, device } = createMockEngine();
        const asset = await loadMeshLoD(engine, sourceBuffer(statueBytes()));
        expect(asset.state).toBe("ready");
        expect(asset.diagnostics.residentPageCount).toBe(asset.metadata.pinnedPageCount);
        expect(asset.diagnostics.residentPageCount).toBe(1);
        // One arena buffer + exactly one upload (the single pinned page); fine pages untouched.
        expect(device.buffers).toHaveLength(1);
        expect(device.writes).toHaveLength(1);
        expect(device.writes[0]!.offset).toBe(0); // pinned pages occupy the arena prefix
    });

    it("bootstraps a URL with two requests and no fine page fetch", async () => {
        const file = statueBytes();
        const server = rangeServer(file);
        const { engine } = createMockEngine();
        const asset = await loadMeshLoD(engine, "https://cdn.test/statue.mlod", { request: { fetch: server.fetch } });
        expect(asset.state).toBe("ready");
        expect(asset.diagnostics.residentPageCount).toBe(1);
        // Header read + one continuation through bootstrapBytes; pinned decode needs no extra fetch.
        expect(server.calls).toBe(2);
        expect(asset.diagnostics.downloadedBytes).toBeLessThan(file.length);
    });

    it("reports effective settings and pinned residency in diagnostics", async () => {
        const { engine } = createMockEngine();
        const asset = await loadMeshLoD(engine, sourceBuffer(statueBytes()), { screenSpaceError: 3, cacheCapacityBytes: 16 * 1024 * 1024 });
        expect(asset.diagnostics.pinnedPageCount).toBe(1);
        expect(asset.diagnostics.gpuCacheUsedBytes).toBeGreaterThan(0);
        expect(asset.diagnostics.gpuCacheUsedBytes % (64 * 1024)).toBe(0);
        expect(asset.diagnostics.gpuCacheCapacityBytes).toBe(16 * 1024 * 1024);
        expect(asset._runtime.settings.screenSpaceError).toBe(3);
    });
});

describe("loadMeshLoD — budget and limit boundaries", () => {
    it("rejects a budget below the pinned allocation with MLOD_BUDGET_TOO_SMALL", async () => {
        const bytes = statueBytes();
        const probe = await loadMeshLoD(createMockEngine().engine, sourceBuffer(bytes));
        const pinned = probe.diagnostics.gpuCacheUsedBytes;
        _setMeshLoDPageDecoder(createFillDecoder().decoder);
        await expect(loadMeshLoD(createMockEngine().engine, sourceBuffer(bytes), { cacheCapacityBytes: pinned, cacheBudgetBytes: pinned - 1 })).rejects.toMatchObject({
            code: "MLOD_BUDGET_TOO_SMALL",
        });
    });

    it("rejects a capacity below the pinned allocation with MLOD_BUDGET_TOO_SMALL", async () => {
        const bytes = statueBytes();
        const probe = await loadMeshLoD(createMockEngine().engine, sourceBuffer(bytes));
        const pinned = probe.diagnostics.gpuCacheUsedBytes;
        _setMeshLoDPageDecoder(createFillDecoder().decoder);
        await expect(loadMeshLoD(createMockEngine().engine, sourceBuffer(bytes), { cacheCapacityBytes: pinned - 1 })).rejects.toMatchObject({
            code: "MLOD_BUDGET_TOO_SMALL",
        });
    });

    it("rejects when device storage limits cannot hold the arena with MLOD_DEVICE_LIMIT", async () => {
        const device = createMockDevice(32 * 1024); // below the 64 KiB block minimum
        const { engine } = createMockEngine(device);
        await expect(loadMeshLoD(engine, sourceBuffer(statueBytes()))).rejects.toMatchObject({ code: "MLOD_DEVICE_LIMIT" });
    });
});

describe("loadMeshLoD — pinned failure", () => {
    it("fails initialization on a corrupt pinned page (MLOD_PAGE_INTEGRITY)", async () => {
        const bytes = statueBytes();
        // Locate the single pinned page (arena prefix) and corrupt a byte inside it.
        const parsed = parseMeshLoDContainer(bytes);
        const pinned = parsed.pageRecords.find((p) => p.pinned)!;
        bytes[pinned.offset + 96] = bytes[pinned.offset + 96]! ^ 0xff;
        let threw: unknown;
        try {
            await loadMeshLoD(createMockEngine().engine, sourceBuffer(bytes));
        } catch (error) {
            threw = error;
        }
        expect(isMeshLoDError(threw) && threw.code).toBe("MLOD_PAGE_INTEGRITY");
    });

    it("maps a decoder failure to MLOD_DECODER_FAILURE", async () => {
        const throwing: MeshoptDecoderModule = {
            ready: Promise.resolve(),
            decodeGltfBuffer() {
                throw new Error("codec failure");
            },
        };
        _setMeshLoDPageDecoder(throwing);
        await expect(loadMeshLoD(createMockEngine().engine, sourceBuffer(statueBytes()))).rejects.toMatchObject({ code: "MLOD_DECODER_FAILURE" });
    });
});
