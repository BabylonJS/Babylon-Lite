import { describe, expect, it } from "vitest";
import { createMeshLoDNetworkSimulator } from "../../../../lab/lite/src/demos/mesh-lod-network-simulator.js";

function fakeResponse(bytes: Uint8Array, status = 206, headers: Record<string, string> = {}): Response {
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(bytes);
            controller.close();
        },
    });
    return new Response(body, { status, statusText: status === 206 ? "Partial Content" : "OK", headers });
}

function bytes(n: number): Uint8Array {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        out[i] = i % 256;
    }
    return out;
}

describe("createMeshLoDNetworkSimulator", () => {
    it("passes non-.mlod requests straight through without delay", async () => {
        const waits: number[] = [];
        let called = 0;
        const baseFetch = (async () => {
            called++;
            return fakeResponse(bytes(10), 200);
        }) as unknown as typeof fetch;
        const sim = createMeshLoDNetworkSimulator(baseFetch, { bandwidthBytesPerSecond: 1000, latencyMs: 100, wait: (ms) => (waits.push(ms), Promise.resolve()) });
        const resp = await sim.fetch("https://host/environment.env");
        expect(called).toBe(1);
        expect(waits).toEqual([]);
        expect(resp.status).toBe(200);
    });

    it("applies latency before the request and throttles the body while preserving status/headers/bytes", async () => {
        const data = bytes(300);
        const baseFetch = (async () =>
            fakeResponse(data, 206, { "content-range": "bytes 0-299/1000", "accept-ranges": "bytes", "content-length": "300" })) as unknown as typeof fetch;
        const waits: number[] = [];
        const sim = createMeshLoDNetworkSimulator(baseFetch, {
            bandwidthBytesPerSecond: 1000,
            latencyMs: 50,
            chunkBytes: 100,
            wait: (ms) => (waits.push(ms), Promise.resolve()),
        });

        const resp = await sim.fetch("https://host/statue.mesh000.prim000.mlod", { headers: { Range: "bytes=0-299" } });
        expect(resp.status).toBe(206);
        expect(resp.headers.get("content-range")).toBe("bytes 0-299/1000");
        expect(resp.headers.get("accept-ranges")).toBe("bytes");

        const roundTrip = new Uint8Array(await resp.arrayBuffer());
        expect(roundTrip.length).toBe(300);
        expect([...roundTrip]).toEqual([...data]);

        // 50 ms latency once, then three 100-byte chunks at 1000 B/s = 100 ms each.
        expect(waits[0]).toBe(50);
        expect(waits.slice(1)).toEqual([100, 100, 100]);
    });

    it("does not throttle the body when bandwidth is unlimited", async () => {
        const data = bytes(500);
        const original = fakeResponse(data, 206, { "content-range": "bytes 0-499/1000" });
        const baseFetch = (async () => original) as unknown as typeof fetch;
        const waits: number[] = [];
        const sim = createMeshLoDNetworkSimulator(baseFetch, { bandwidthBytesPerSecond: Infinity, latencyMs: 0, wait: (ms) => (waits.push(ms), Promise.resolve()) });
        const resp = await sim.fetch("https://host/statue.mesh000.prim000.mlod");
        expect(resp).toBe(original); // untouched, no re-wrap
        expect(waits).toEqual([]);
    });

    it("rejects and never fetches when the request is already aborted", async () => {
        let called = 0;
        const baseFetch = (async () => {
            called++;
            return fakeResponse(bytes(10));
        }) as unknown as typeof fetch;
        const sim = createMeshLoDNetworkSimulator(baseFetch, { bandwidthBytesPerSecond: 1000, latencyMs: 100 });
        const controller = new AbortController();
        controller.abort();
        await expect(sim.fetch("https://host/statue.mesh000.prim000.mlod", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
        expect(called).toBe(0);
    });

    it("reflects live bandwidth/latency/failure updates", () => {
        const baseFetch = (async () => fakeResponse(bytes(1))) as unknown as typeof fetch;
        const sim = createMeshLoDNetworkSimulator(baseFetch, { bandwidthBytesPerSecond: 8 * 1024 * 1024, latencyMs: 100 });
        expect(sim.getSettings()).toEqual({ bandwidthBytesPerSecond: 8 * 1024 * 1024, latencyMs: 100, failureMode: "none" });
        sim.setBandwidthBytesPerSecond(Infinity);
        sim.setLatencyMs(0);
        sim.setFailureMode("unavailable");
        expect(sim.getSettings()).toEqual({ bandwidthBytesPerSecond: Infinity, latencyMs: 0, failureMode: "unavailable" });
    });

    it("rejects .mlod fetches with a network error in 'unavailable' failure mode", async () => {
        let called = 0;
        const baseFetch = (async () => {
            called++;
            return fakeResponse(bytes(10));
        }) as unknown as typeof fetch;
        const sim = createMeshLoDNetworkSimulator(baseFetch, { latencyMs: 0, failureMode: "unavailable" });
        await expect(sim.fetch("https://host/statue.mesh000.prim000.mlod")).rejects.toBeInstanceOf(TypeError);
        expect(called).toBe(0);
    });

    it("corrupts the body (preserving status/headers) in 'corrupt' failure mode", async () => {
        const data = bytes(64);
        const baseFetch = (async () => fakeResponse(data, 206, { "content-range": "bytes 0-63/1000" })) as unknown as typeof fetch;
        const sim = createMeshLoDNetworkSimulator(baseFetch, { latencyMs: 0, failureMode: "corrupt" });
        const resp = await sim.fetch("https://host/statue.mesh000.prim000.mlod");
        expect(resp.status).toBe(206);
        expect(resp.headers.get("content-range")).toBe("bytes 0-63/1000");
        const roundTrip = new Uint8Array(await resp.arrayBuffer());
        expect(roundTrip.length).toBe(64);
        expect([...roundTrip]).not.toEqual([...data]); // at least one byte flipped
    });
});
