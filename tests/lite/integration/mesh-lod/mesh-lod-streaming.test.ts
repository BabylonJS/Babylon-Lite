/** MeshLoD streaming residency integration tests (Task 6.3).
 *
 *  Drives the full CPU-selection frame loop through the public facade over a
 *  controllable range server + fill decoder + mock device to prove the demand →
 *  scheduler → decode → reserve → upload → residency commit pipeline (architecture §11).
 *  Fine pages progressively refine the coarse LOD; pause/resume, permanent failure,
 *  budget reduction, stale-generation completions, and camera-movement cancellation are
 *  each page-local and never fail the coarse asset (REQ-STREAM-1..6, REQ-SEL-3/6/7).
 *  Deterministic real-WebGPU pixels are validated in the browser. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    addMeshLoDToScene,
    createMeshLoDInstance,
    disposeMeshLoDAsset,
    loadMeshLoD,
    setMeshLoDCacheBudget,
    setMeshLoDScreenSpaceError,
    setMeshLoDStreamingPaused,
} from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod.js";
import { _setMeshLoDPageDecoder } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-page-decoder.js";
import type { MeshLoDAsset, MeshLoDLoadOptions } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod.js";
import type { SceneContext } from "../../../../packages/babylon-lite/src/scene/scene-core.js";
import type { Camera } from "../../../../packages/babylon-lite/src/camera/camera.js";
import type { PbrMaterialProps } from "../../../../packages/babylon-lite/src/material/pbr/pbr-material.js";
import type { EngineContext } from "../../../../packages/babylon-lite/src/engine/engine.js";
import type { RenderTargetSignature } from "../../../../packages/babylon-lite/src/engine/render-target.js";
import { createFillDecoder, createMockEngine, createMockRenderPass } from "../../unit/mesh-lod/fixtures/gpu-mock.js";

const STATUE = fileURLToPath(new URL("../../../../lab/public/mesh-lod/harvard-yenching_institute_statue.mesh000.prim000.mlod", import.meta.url));
/** First byte of the first fine (non-pinned) page: everything below is coarse bootstrap. */
const FINE_FLOOR = 262144;
const SIG: RenderTargetSignature = { _colorFormat: "rgba8unorm", _depthStencilFormat: "depth24plus-stencil8", _sampleCount: 1 };

function statueFile(): Uint8Array {
    return new Uint8Array(readFileSync(STATUE));
}

function bufferOf(bytes: Uint8Array): ArrayBuffer {
    return bytes.slice().buffer as ArrayBuffer;
}

type FinePolicy = "deliver" | "fail404" | "hold";

interface Deferred {
    readonly start: number;
    resolve(): void;
    aborted: boolean;
}

interface StreamServer {
    fetch: typeof globalThis.fetch;
    calls: number;
    fineRequests: number;
    fineAborts: number;
    pending: Deferred[];
    policy: FinePolicy;
    resolveAll(): void;
}

/** A range server for the statue that serves coarse bootstrap ranges normally and
 *  applies a configurable policy to fine-page ranges: immediate 206, permanent 404, or
 *  a held promise the test resolves (and that rejects on abort). */
function streamServer(file: Uint8Array, policy: FinePolicy): StreamServer {
    const server: StreamServer = {
        calls: 0,
        fineRequests: 0,
        fineAborts: 0,
        pending: [],
        policy,
        resolveAll() {
            const held = server.pending.splice(0);
            for (const d of held) {
                d.resolve();
            }
        },
        fetch: (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
            server.calls += 1;
            const range = new Headers(init?.headers).get("Range");
            if (!range) {
                return new Response(bufferOf(file), { status: 200, headers: { "Content-Length": String(file.length) } });
            }
            const match = /^bytes=(\d+)-(\d+)$/.exec(range)!;
            const start = Number(match[1]);
            const end = Math.min(Number(match[2]), file.length - 1);
            const slice = (): Response =>
                new Response(bufferOf(file.subarray(start, end + 1)), {
                    status: 206,
                    headers: { "Content-Range": `bytes ${start}-${end}/${file.length}`, "Content-Length": String(end - start + 1) },
                });
            if (start < FINE_FLOOR) {
                return slice();
            }
            server.fineRequests += 1;
            if (server.policy === "fail404") {
                return new Response(null, { status: 404 });
            }
            if (server.policy === "hold") {
                return new Promise<Response>((resolve, reject) => {
                    const deferred: Deferred = { start, aborted: false, resolve: () => resolve(slice()) };
                    const signal = init?.signal;
                    if (signal) {
                        signal.addEventListener("abort", () => {
                            deferred.aborted = true;
                            server.fineAborts += 1;
                            const i = server.pending.indexOf(deferred);
                            if (i !== -1) {
                                server.pending.splice(i, 1);
                            }
                            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
                        });
                    }
                    server.pending.push(deferred);
                });
            }
            return slice();
        }) as typeof globalThis.fetch,
    };
    return server;
}

function fakeScene(engine: EngineContext): SceneContext {
    return { _deferredBuilders: [], _renderables: [], _disposables: [], surface: { engine } } as unknown as SceneContext;
}

/** Camera looking down -Z from distance `dist`; a small distance projects a large error
 *  and demands fine refinement, a large one keeps the coarse LOD. */
function cameraAt(dist: number): Camera {
    return {
        fov: 0.8,
        nearPlane: 0.1,
        farPlane: 1000,
        worldMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -dist, 1]),
        worldMatrixVersion: 1,
    } as unknown as Camera;
}

interface Harness {
    engine: EngineContext;
    asset: MeshLoDAsset;
    frame(dist: number): void;
    submit(): void;
    settle(): Promise<void>;
}

async function setup(source: string | ArrayBuffer, fetchImpl: typeof globalThis.fetch | undefined, options?: MeshLoDLoadOptions): Promise<Harness> {
    const engine = createMockEngine().engine;
    const request = fetchImpl ? { fetch: fetchImpl } : undefined;
    const asset = await loadMeshLoD(engine, source, { selectionMode: "cpu", ...options, request });
    const scene = fakeScene(engine);
    addMeshLoDToScene(scene, createMeshLoDInstance(asset, {} as PbrMaterialProps));
    for (const builder of scene._deferredBuilders) {
        await builder();
    }
    const binding = scene._renderables[0]!.bind(engine, SIG);
    return {
        engine,
        asset,
        frame(dist: number): void {
            binding.update!({ targetWidth: 1280, targetHeight: 720, _camera: cameraAt(dist) });
            binding.draw(createMockRenderPass() as unknown as GPURenderPassEncoder, engine);
        },
        submit(): void {
            const retirements = engine._retirements;
            engine._retirements = null;
            retirements?.forEach((retire) => retire());
        },
        async settle(): Promise<void> {
            for (let i = 0; i < 6; i++) {
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
        },
    };
}

beforeEach(() => {
    _setMeshLoDPageDecoder(createFillDecoder().decoder);
});
afterEach(() => {
    _setMeshLoDPageDecoder(null);
});

describe("MeshLoD streaming — progressive fine residency", () => {
    it("streams fine pages resident across frames and satisfies demanded groups", async () => {
        const file = statueFile();
        const server = streamServer(file, "deliver");
        const h = await setup("https://cdn.test/statue.mlod", server.fetch, { residencyHoldFrames: 4 });
        expect(h.asset.diagnostics.residentPageCount).toBe(1); // only the pinned coarse page at load

        let previousResident = 1;
        let sawDemand = false;
        for (let frame = 0; frame < 8; frame++) {
            h.frame(3);
            await h.settle();
            h.submit();
            sawDemand = sawDemand || h.asset.diagnostics.fallbackGroupCount > 0;
            expect(h.asset.diagnostics.residentPageCount).toBeGreaterThanOrEqual(previousResident); // residency only grows
            previousResident = h.asset.diagnostics.residentPageCount;
        }

        expect(h.asset.state).toBe("ready");
        expect(sawDemand).toBe(true); // fine detail was demanded
        expect(server.fineRequests).toBeGreaterThan(0);
        expect(h.asset.diagnostics.residentPageCount).toBeGreaterThan(1); // fine pages joined the coarse page
        expect(h.asset.diagnostics.downloadedBytes).toBeGreaterThan(FINE_FLOOR);
        // Output progressively improved: the refined selection renders far more than the
        // 46-triangle coarse terminal LOD (the draw-vertex buffer grew to fit it).
        expect(h.asset.diagnostics.renderedTriangleCount).toBeGreaterThan(46);
        // GPU residency accounting is exact and block-aligned; committed bytes never exceed the budget.
        expect(h.asset.diagnostics.gpuCacheUsedBytes % 65536).toBe(0);
        expect(h.asset.diagnostics.gpuCacheUsedBytes).toBeLessThanOrEqual(h.asset.diagnostics.gpuCacheBudgetBytes);
        // Every demanded finer group is now fully resident (a group leaves the fallback set
        // only once all of its pages are resident — atomic refinement).
        expect(h.asset.diagnostics.fallbackGroupCount).toBe(0);
        disposeMeshLoDAsset(h.asset);
    });

    it("keeps the coarse geometry whole on every frame while fine pages stream in", async () => {
        const file = statueFile();
        const server = streamServer(file, "deliver");
        const h = await setup("https://cdn.test/statue.mlod", server.fetch, { residencyHoldFrames: 4 });
        for (let frame = 0; frame < 8; frame++) {
            h.frame(3);
            // No holes mid-stream: one indirect draw and non-empty coarse geometry hold
            // every frame, even while pages are still in flight (REQ-SEL-7).
            expect(h.asset.diagnostics.renderedTriangleCount).toBeGreaterThan(0);
            expect(h.asset.state).toBe("ready");
            await h.settle();
            h.submit();
        }
        disposeMeshLoDAsset(h.asset);
    });
});

describe("MeshLoD streaming — public controls", () => {
    it("suppresses new fine requests while paused and resumes on unpause", async () => {
        const file = statueFile();
        const server = streamServer(file, "deliver");
        const h = await setup("https://cdn.test/statue.mlod", server.fetch);
        setMeshLoDStreamingPaused(h.asset, true);
        expect(h.asset.diagnostics.streamingPaused).toBe(true);

        for (let frame = 0; frame < 4; frame++) {
            h.frame(3);
            await h.settle();
            h.submit();
        }
        expect(server.fineRequests).toBe(0); // paused: demand queues but never transfers
        expect(h.asset.diagnostics.residentPageCount).toBe(1);
        expect(h.asset.diagnostics.queuedPageCount).toBeGreaterThan(0);

        setMeshLoDStreamingPaused(h.asset, false);
        expect(h.asset.diagnostics.streamingPaused).toBe(false);
        for (let frame = 0; frame < 4; frame++) {
            h.frame(3);
            await h.settle();
            h.submit();
        }
        expect(server.fineRequests).toBeGreaterThan(0);
        expect(h.asset.diagnostics.residentPageCount).toBeGreaterThan(1);
        disposeMeshLoDAsset(h.asset);
    });
});

describe("MeshLoD streaming — failure is page-local", () => {
    it("records a permanent fine failure without failing the coarse asset", async () => {
        const file = statueFile();
        const server = streamServer(file, "fail404");
        const h = await setup("https://cdn.test/statue.mlod", server.fetch);
        for (let frame = 0; frame < 4; frame++) {
            h.frame(3);
            await h.settle();
            h.submit();
        }
        expect(server.fineRequests).toBeGreaterThan(0);
        expect(h.asset.diagnostics.terminalFailedPageCount).toBeGreaterThan(0);
        // Coarse fallback intact: no fine page resident, asset never fails, coarse renders.
        expect(h.asset.diagnostics.residentPageCount).toBe(1);
        expect(h.asset.state).toBe("ready");
        expect(h.asset.diagnostics.renderedTriangleCount).toBeGreaterThan(0);
        disposeMeshLoDAsset(h.asset);
    });
});

describe("MeshLoD streaming — cache eviction", () => {
    it("evicts aged, unreferenced fine pages when the budget is reduced", async () => {
        const file = statueFile();
        const server = streamServer(file, "deliver");
        // Small residency hold so pages age out quickly; ample capacity to stream in.
        const h = await setup("https://cdn.test/statue.mlod", server.fetch, { residencyHoldFrames: 2, cacheCapacityBytes: 32 * 1024 * 1024 });
        for (let frame = 0; frame < 8; frame++) {
            h.frame(3);
            await h.settle();
            h.submit();
        }
        const streamedResident = h.asset.diagnostics.residentPageCount;
        expect(streamedResident).toBeGreaterThan(2);

        // Move far so the fine pages are no longer referenced/demanded, and let them age
        // past the 2-frame residency hold.
        for (let frame = 0; frame < 6; frame++) {
            h.frame(60);
            await h.settle();
            h.submit();
        }
        // Reduce the effective budget to just the pinned page + one fine page.
        const reducedBudget = 3 * 2 * 65536;
        setMeshLoDCacheBudget(h.asset, reducedBudget);
        expect(h.asset.diagnostics.gpuCacheBudgetBytes).toBe(reducedBudget);
        h.frame(60);
        await h.settle();
        h.submit();

        expect(h.asset.diagnostics.residentPageCount).toBeLessThan(streamedResident);
        expect(h.asset.diagnostics.gpuCacheUsedBytes).toBeLessThanOrEqual(reducedBudget);
        expect(h.asset.diagnostics.residentPageCount).toBeGreaterThanOrEqual(1); // pinned never evicted
        disposeMeshLoDAsset(h.asset);
    });
});

describe("MeshLoD streaming — stale and cancelled completions", () => {
    it("discards a completion whose generation is stale before mutating residency", async () => {
        const file = statueFile();
        const server = streamServer(file, "hold");
        const h = await setup("https://cdn.test/statue.mlod", server.fetch);
        h.frame(3);
        await h.settle();
        expect(h.asset.diagnostics.inFlightPageCount).toBeGreaterThan(0);
        const resident = h.asset.diagnostics.residentPageCount;

        // Simulate a device-recovery generation bump, then let the in-flight fetches
        // complete: every completion is now stale and must not touch residency.
        h.asset._runtime.generation += 1;
        server.resolveAll();
        await h.settle();

        expect(h.asset.diagnostics.residentPageCount).toBe(resident);
        expect(h.asset.state).toBe("ready");
        disposeMeshLoDAsset(h.asset);
    });

    it("aborts an in-flight fine request once it is no longer demanded", async () => {
        const file = statueFile();
        const server = streamServer(file, "hold");
        const h = await setup("https://cdn.test/statue.mlod", server.fetch);
        h.frame(3);
        await h.settle();
        expect(h.asset.diagnostics.inFlightPageCount).toBeGreaterThan(0);

        // Demand stops (here via a large screen-space-error target — equivalently the
        // camera moving away): after the two-frame obsolete grace the scheduler aborts the
        // in-flight transfers and clears the request table (REQ-STREAM-2).
        setMeshLoDScreenSpaceError(h.asset, 1e6);
        for (let frame = 0; frame < 4; frame++) {
            h.frame(3);
            await h.settle();
            h.submit();
        }
        expect(server.fineAborts).toBeGreaterThan(0);
        expect(h.asset.diagnostics.inFlightPageCount).toBe(0);
        expect(h.asset.diagnostics.requestedPageCount).toBe(0);
        expect(h.asset.state).toBe("ready");
        disposeMeshLoDAsset(h.asset);
    });

    it("cancels outstanding requests on disposal", async () => {
        const file = statueFile();
        const server = streamServer(file, "hold");
        const h = await setup("https://cdn.test/statue.mlod", server.fetch);
        h.frame(3);
        await h.settle();
        expect(h.asset.diagnostics.inFlightPageCount).toBeGreaterThan(0);
        disposeMeshLoDAsset(h.asset);
        expect(server.fineAborts).toBeGreaterThan(0);
        expect(h.asset.state).toBe("disposed");
        // Resolving now is a no-op: nothing throws and the asset stays disposed.
        server.resolveAll();
        await h.settle();
        expect(h.asset.state).toBe("disposed");
    });
});
