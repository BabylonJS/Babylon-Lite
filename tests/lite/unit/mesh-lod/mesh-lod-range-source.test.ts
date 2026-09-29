/** MeshLoD range-source unit tests: in-memory and URL sources, HTTP protocol
 *  validation, full-body retention, custom fetch, and abort. */

import { describe, expect, it, vi } from "vitest";
import { createMeshLoDRangeSource } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-range-source.js";
import { isMeshLoDError, type MeshLoDErrorCode } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-errors.js";
import { buildMinimalContainer } from "./fixtures/mlod-fixture.js";

const file = buildMinimalContainer().bytes;

/** Copy into a fresh ArrayBuffer accepted as a Response/Blob body under TS's
 *  stricter typed-array buffer typing. */
function bufferOf(bytes: Uint8Array): ArrayBuffer {
    return bytes.slice().buffer as ArrayBuffer;
}

interface FetchLog {
    fetch: typeof globalThis.fetch;
    calls: Array<{ url: string; range: string | null; headers: Headers }>;
}

function rangeServer(options?: { force200?: boolean }): FetchLog {
    const calls: FetchLog["calls"] = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const headers = new Headers(init?.headers);
        const range = headers.get("Range");
        calls.push({ url: String(url), range, headers });
        if (options?.force200 || !range) {
            return new Response(bufferOf(file), { status: 200, headers: { "Content-Length": String(file.length) } });
        }
        const match = /^bytes=(\d+)-(\d+)$/.exec(range)!;
        const start = Number(match[1]);
        const end = Math.min(Number(match[2]), file.length - 1);
        const body = file.subarray(start, end + 1);
        return new Response(bufferOf(body), { status: 206, headers: { "Content-Range": `bytes ${start}-${end}/${file.length}`, "Content-Length": String(body.length) } });
    }) as typeof globalThis.fetch;
    return { fetch, calls };
}

async function expectReadError(read: () => Promise<unknown>, code: MeshLoDErrorCode): Promise<void> {
    let threw: unknown;
    try {
        await read();
    } catch (error) {
        threw = error;
    }
    expect(isMeshLoDError(threw)).toBe(true);
    expect(isMeshLoDError(threw) && threw.code).toBe(code);
}

describe("createMeshLoDRangeSource — in-memory sources", () => {
    it("treats an ArrayBuffer as a complete file", async () => {
        const src = await createMeshLoDRangeSource(bufferOf(file));
        expect(src.completeBytes).not.toBeNull();
        expect(src.totalBytes).toBe(file.length);
        expect(src.downloadedBytes).toBe(0);
        const slice = await src.read(0, 15);
        expect(Array.from(slice)).toEqual(Array.from(file.subarray(0, 16)));
    });

    it("reads a Blob fully into memory", async () => {
        const src = await createMeshLoDRangeSource(new Blob([bufferOf(file)]));
        expect(src.completeBytes).not.toBeNull();
        expect(src.totalBytes).toBe(file.length);
    });
});

describe("createMeshLoDRangeSource — URL source", () => {
    it("serves 206 ranges and tracks totals and downloaded bytes", async () => {
        const server = rangeServer();
        const src = await createMeshLoDRangeSource("https://cdn.test/a.mlod", { fetch: server.fetch });
        const chunk = await src.read(0, 63);
        expect(Array.from(chunk)).toEqual(Array.from(file.subarray(0, 64)));
        expect(src.totalBytes).toBe(file.length);
        expect(src.downloadedBytes).toBe(64);
        expect(server.calls[0]!.range).toBe("bytes=0-63");
    });

    it("retains a 200 full body and serves later reads from memory", async () => {
        const server = rangeServer({ force200: true });
        const src = await createMeshLoDRangeSource("https://cdn.test/a.mlod", { fetch: server.fetch });
        await src.read(0, 63);
        expect(src.completeBytes).not.toBeNull();
        const again = await src.read(100, 131);
        expect(Array.from(again)).toEqual(Array.from(file.subarray(100, 132)));
        expect(server.calls).toHaveLength(1); // no second network request
    });

    it("merges caller headers without mutating them", async () => {
        const server = rangeServer();
        const callerHeaders = new Headers({ Authorization: "Bearer x" });
        const src = await createMeshLoDRangeSource("https://cdn.test/a.mlod", { fetch: server.fetch, headers: callerHeaders });
        await src.read(0, 10);
        expect(server.calls[0]!.headers.get("Authorization")).toBe("Bearer x");
        expect(server.calls[0]!.headers.get("Range")).toBe("bytes=0-10");
        expect(callerHeaders.has("Range")).toBe(false); // caller input untouched
    });

    it("rejects an already-aborted signal", async () => {
        const server = rangeServer();
        const src = await createMeshLoDRangeSource("https://cdn.test/a.mlod", { fetch: server.fetch });
        const controller = new AbortController();
        controller.abort();
        await expectReadError(() => src.read(0, 10, controller.signal), "MLOD_ABORTED");
        expect(server.calls).toHaveLength(0);
    });

    it("maps a fetch AbortError to MLOD_ABORTED", async () => {
        const fetch = vi.fn(async () => {
            throw new DOMException("aborted", "AbortError");
        }) as unknown as typeof globalThis.fetch;
        const src = await createMeshLoDRangeSource("https://cdn.test/a.mlod", { fetch });
        await expectReadError(() => src.read(0, 10), "MLOD_ABORTED");
    });

    it.each<[string, (r: Request | string | URL, i?: RequestInit) => Response, MeshLoDErrorCode]>([
        ["404 status", () => new Response(null, { status: 404 }), "MLOD_HTTP_STATUS"],
        ["304 status", () => new Response(null, { status: 304 }), "MLOD_HTTP_STATUS"],
        [
            "non-identity encoding",
            () => new Response(bufferOf(file.subarray(0, 11)), { status: 206, headers: { "Content-Range": `bytes 0-10/${file.length}`, "Content-Encoding": "gzip" } }),
            "MLOD_HTTP_ENCODING",
        ],
        ["missing content-range", () => new Response(bufferOf(file.subarray(0, 11)), { status: 206 }), "MLOD_HTTP_RANGE"],
        [
            "wrong content-range start",
            () => new Response(bufferOf(file.subarray(0, 11)), { status: 206, headers: { "Content-Range": `bytes 5-15/${file.length}` } }),
            "MLOD_HTTP_RANGE",
        ],
        ["short body", () => new Response(bufferOf(file.subarray(0, 5)), { status: 206, headers: { "Content-Range": `bytes 0-10/${file.length}` } }), "MLOD_HTTP_RANGE"],
        [
            "multipart",
            () =>
                new Response(bufferOf(file.subarray(0, 11)), {
                    status: 206,
                    headers: { "Content-Range": `bytes 0-10/${file.length}`, "Content-Type": "multipart/byteranges; boundary=x" },
                }),
            "MLOD_HTTP_RANGE",
        ],
    ])("rejects %s", async (_name, respond, code) => {
        const fetch = (async (r: Request | string | URL, i?: RequestInit) => respond(r, i)) as typeof globalThis.fetch;
        const src = await createMeshLoDRangeSource("https://cdn.test/a.mlod", { fetch });
        await expectReadError(() => src.read(0, 10), code);
    });
});
