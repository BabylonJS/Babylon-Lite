/** MeshLoD HTTP bootstrap integration tests.
 *
 *  Drives the full public `loadMeshLoD` path against deterministic fake transports
 *  (custom `fetch`) and complete in-memory sources. Covers the two-request coarse
 *  bootstrap, the full-body 200 fallback, a real partial-bootstrap statue asset,
 *  abort, and explicit protocol failure. No WebGPU device is needed — Phase 3 stops
 *  after metadata + coarse-page validation. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadMeshLoD } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod.js";
import { isMeshLoDError } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-errors.js";
import { _setMeshLoDPageDecoder } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-page-decoder.js";
import { buildMinimalContainer } from "../../unit/mesh-lod/fixtures/mlod-fixture.js";
import { createFillDecoder, createMockEngine } from "../../unit/mesh-lod/fixtures/gpu-mock.js";

const { engine } = createMockEngine();

// The loader now decodes + uploads pinned pages, so every load needs a device and
// a decoder. Inject the fill decoder (no WASM) before each case and clear it after.
beforeEach(() => {
    _setMeshLoDPageDecoder(createFillDecoder().decoder);
});
afterAll(() => {
    _setMeshLoDPageDecoder(null);
});

/** Copy into a fresh ArrayBuffer accepted as a Response body under TS's stricter
 *  typed-array buffer typing. */
function bufferOf(bytes: Uint8Array): ArrayBuffer {
    return bytes.slice().buffer as ArrayBuffer;
}

interface Server {
    fetch: typeof globalThis.fetch;
    calls: number;
}

function rangeServer(file: Uint8Array, options?: { force200?: boolean }): Server {
    const server: Server = {
        calls: 0,
        fetch: (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
            server.calls += 1;
            const range = new Headers(init?.headers).get("Range");
            if (options?.force200 || !range) {
                return new Response(bufferOf(file), { status: 200, headers: { "Content-Length": String(file.length) } });
            }
            const match = /^bytes=(\d+)-(\d+)$/.exec(range)!;
            const start = Number(match[1]);
            const end = Math.min(Number(match[2]), file.length - 1);
            const body = file.subarray(start, end + 1);
            return new Response(bufferOf(body), { status: 206, headers: { "Content-Range": `bytes ${start}-${end}/${file.length}`, "Content-Length": String(body.length) } });
        }) as typeof globalThis.fetch,
    };
    return server;
}

describe("loadMeshLoD — HTTP bootstrap", () => {
    it("bootstraps a URL with two range requests", async () => {
        const file = buildMinimalContainer().bytes;
        const server = rangeServer(file);
        const asset = await loadMeshLoD(engine, "https://cdn.test/a.mlod", { request: { fetch: server.fetch } });
        expect(asset.state).toBe("ready");
        expect(asset.metadata.clusterCount).toBe(2);
        expect(asset.metadata.pageCount).toBe(1);
        // header (0-65535) then continuation through bootstrapBytes.
        expect(server.calls).toBe(2);
    });

    it("uses a full-body 200 response with a single request", async () => {
        const file = buildMinimalContainer().bytes;
        const server = rangeServer(file, { force200: true });
        const asset = await loadMeshLoD(engine, "https://cdn.test/a.mlod", { request: { fetch: server.fetch } });
        expect(asset.state).toBe("ready");
        expect(server.calls).toBe(1);
    });

    it("loads a complete ArrayBuffer source without fetching", async () => {
        const file = buildMinimalContainer().bytes;
        const asset = await loadMeshLoD(engine, bufferOf(file));
        expect(asset.state).toBe("ready");
        expect(asset.diagnostics.downloadedBytes).toBe(0);
    });

    it("rejects an aborted load", async () => {
        const file = buildMinimalContainer().bytes;
        const server = rangeServer(file);
        const controller = new AbortController();
        controller.abort();
        let threw: unknown;
        try {
            await loadMeshLoD(engine, "https://cdn.test/a.mlod", { request: { fetch: server.fetch }, signal: controller.signal });
        } catch (error) {
            threw = error;
        }
        expect(isMeshLoDError(threw) && threw.code).toBe("MLOD_ABORTED");
    });

    it("rejects an unusable HTTP status", async () => {
        const fetch = (async () => new Response(null, { status: 500 })) as typeof globalThis.fetch;
        let threw: unknown;
        try {
            await loadMeshLoD(engine, "https://cdn.test/a.mlod", { request: { fetch } });
        } catch (error) {
            threw = error;
        }
        expect(isMeshLoDError(threw) && threw.code).toBe("MLOD_HTTP_STATUS");
    });

    it("partial-bootstraps a real statue asset over range requests", async () => {
        const assetPath = fileURLToPath(new URL("../../../../lab/public/mesh-lod/harvard-yenching_institute_statue.mesh000.prim000.mlod", import.meta.url));
        const file = new Uint8Array(readFileSync(assetPath));
        const server = rangeServer(file);
        const asset = await loadMeshLoD(engine, "https://cdn.test/statue.mlod", { request: { fetch: server.fetch } });
        expect(asset.state).toBe("ready");
        expect(asset.metadata.clusterCount).toBe(2491);
        expect(asset.metadata.pageCount).toBe(40);
        expect(asset.metadata.pinnedPageCount).toBe(1);
        // Coarse bootstrap only: fewer bytes than the full file were downloaded.
        expect(asset.diagnostics.downloadedBytes).toBeGreaterThan(0);
        expect(asset.diagnostics.downloadedBytes).toBeLessThan(file.length);
        expect(server.calls).toBe(2);
    });
});
