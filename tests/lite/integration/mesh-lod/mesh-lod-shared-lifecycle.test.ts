/** MeshLoD shared-asset lifecycle integration tests (Task 7.1 — REQ-INT-4/7, REQ-LOAD-3).
 *
 *  Disposal and scene pruning over the streaming loop: a completion racing disposal never
 *  makes a page resident; removing one of two instances (or one of two scenes sharing an
 *  asset) leaves the others rendering and the asset live; and a scene never disposes an
 *  asset another scene still uses. Driven CPU-side against a controllable range server +
 *  fill decoder + mock device (real WebGPU pixels are covered by the browser harness). */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addMeshLoDToScene, createMeshLoDInstance, disposeMeshLoDAsset, loadMeshLoD, removeMeshLoDFromScene } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod.js";
import { _setMeshLoDPageDecoder } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-page-decoder.js";
import type { MeshLoDAsset } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod.js";
import type { SceneContext } from "../../../../packages/babylon-lite/src/scene/scene-core.js";
import type { Camera } from "../../../../packages/babylon-lite/src/camera/camera.js";
import type { PbrMaterialProps } from "../../../../packages/babylon-lite/src/material/pbr/pbr-material.js";
import type { EngineContext } from "../../../../packages/babylon-lite/src/engine/engine.js";
import type { RenderTargetSignature } from "../../../../packages/babylon-lite/src/engine/render-target.js";
import type { DrawBinding } from "../../../../packages/babylon-lite/src/render/renderable.js";
import { createFillDecoder, createMockEngine, createMockRenderPass } from "../../unit/mesh-lod/fixtures/gpu-mock.js";

const STATUE = fileURLToPath(new URL("../../../../lab/public/mesh-lod/harvard-yenching_institute_statue.mesh000.prim000.mlod", import.meta.url));
const FINE_FLOOR = 262144;
const SIG: RenderTargetSignature = { _colorFormat: "rgba8unorm", _depthStencilFormat: "depth24plus-stencil8", _sampleCount: 1 };

function statueFile(): Uint8Array {
    return new Uint8Array(readFileSync(STATUE));
}
function bufferOf(bytes: Uint8Array): ArrayBuffer {
    return bytes.slice().buffer as ArrayBuffer;
}

interface HeldServer {
    fetch: typeof globalThis.fetch;
    fineRequests: number;
    fineAborts: number;
    pending: { resolve: () => void }[];
    resolveAll(): void;
}

/** Serves coarse ranges immediately; holds every fine-page range until `resolveAll` (and
 *  rejects it on abort), so a dispose/remove can be observed mid-transfer. */
function heldServer(file: Uint8Array): HeldServer {
    const server: HeldServer = {
        fineRequests: 0,
        fineAborts: 0,
        pending: [],
        resolveAll(): void {
            for (const d of server.pending.splice(0)) {
                d.resolve();
            }
        },
        fetch: (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
            const range = new Headers(init?.headers).get("Range");
            if (!range) {
                return new Response(bufferOf(file), { status: 200, headers: { "Content-Length": String(file.length) } });
            }
            const m = /^bytes=(\d+)-(\d+)$/.exec(range)!;
            const start = Number(m[1]);
            const end = Math.min(Number(m[2]), file.length - 1);
            const slice = (): Response =>
                new Response(bufferOf(file.subarray(start, end + 1)), {
                    status: 206,
                    headers: { "Content-Range": `bytes ${start}-${end}/${file.length}`, "Content-Length": String(end - start + 1) },
                });
            if (start < FINE_FLOOR) {
                return slice();
            }
            server.fineRequests += 1;
            return new Promise<Response>((resolve, reject) => {
                const d = { resolve: () => resolve(slice()) };
                init?.signal?.addEventListener("abort", () => {
                    server.fineAborts += 1;
                    const i = server.pending.indexOf(d);
                    if (i !== -1) {
                        server.pending.splice(i, 1);
                    }
                    reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
                });
                server.pending.push(d);
            });
        }) as typeof globalThis.fetch,
    };
    return server;
}

function fakeScene(engine: EngineContext): SceneContext {
    return { _deferredBuilders: [], _renderables: [], _disposables: [], surface: { engine } } as unknown as SceneContext;
}

function cameraAt(dist: number): Camera {
    return {
        fov: 0.8,
        nearPlane: 0.1,
        farPlane: 1000,
        worldMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -dist, 1]),
        worldMatrixVersion: 1,
    } as unknown as Camera;
}

async function buildBinding(engine: EngineContext, scene: SceneContext): Promise<DrawBinding> {
    for (const builder of scene._deferredBuilders) {
        await builder();
    }
    return scene._renderables[scene._renderables.length - 1]!.bind(engine, SIG);
}

function frame(engine: EngineContext, binding: DrawBinding, dist: number): number {
    binding.update!({ targetWidth: 1280, targetHeight: 720, _camera: cameraAt(dist) });
    return binding.draw(createMockRenderPass() as unknown as GPURenderPassEncoder, engine);
}

function submit(engine: EngineContext): void {
    const retirements = engine._retirements;
    engine._retirements = null;
    retirements?.forEach((r) => r());
}

async function settle(): Promise<void> {
    for (let i = 0; i < 6; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

let engine: EngineContext;

beforeEach(() => {
    _setMeshLoDPageDecoder(createFillDecoder().decoder);
    engine = createMockEngine().engine;
});
afterEach(() => {
    _setMeshLoDPageDecoder(null);
});

async function loadStatue(server: HeldServer): Promise<MeshLoDAsset> {
    return loadMeshLoD(engine, "https://cdn.test/statue.mlod", { selectionMode: "cpu", residencyHoldFrames: 2, request: { fetch: server.fetch } });
}

describe("MeshLoD shared-asset lifecycle", () => {
    it("aborts in-flight fetches on disposal and never makes a racing page resident", async () => {
        const server = heldServer(statueFile());
        const asset = await loadStatue(server);
        const scene = fakeScene(engine);
        addMeshLoDToScene(scene, createMeshLoDInstance(asset, {} as PbrMaterialProps));
        const binding = await buildBinding(engine, scene);

        for (let i = 0; i < 4; i++) {
            frame(engine, binding, 3);
            await settle();
            submit(engine);
        }
        expect(server.fineRequests).toBeGreaterThan(0);
        expect(asset.diagnostics.inFlightPageCount).toBeGreaterThan(0);

        disposeMeshLoDAsset(asset);
        expect(asset.state).toBe("disposed");
        expect(server.fineAborts).toBeGreaterThan(0); // in-flight transfers aborted

        // Resolve everything the server was holding: the stale completions must be discarded.
        server.resolveAll();
        await settle();
        expect(asset._runtime.gpu.residentPageCount).toBe(0);
        expect(asset._runtime.gpu.pages.some((p) => p.state === "gpu-resident")).toBe(false);
    });

    it("keeps the shared batch drawing when one of two instances is removed", async () => {
        const server = heldServer(statueFile());
        const asset = await loadStatue(server);
        const scene = fakeScene(engine);
        const material = {} as PbrMaterialProps; // one material object → one shared batch
        const a = createMeshLoDInstance(asset, material);
        const b = createMeshLoDInstance(asset, material);
        addMeshLoDToScene(scene, a);
        addMeshLoDToScene(scene, b);
        const binding = await buildBinding(engine, scene);
        const batch = scene._meshLoDRegistry!.batches[0]!;
        expect(batch.instances).toHaveLength(2);
        expect(frame(engine, binding, 6)).toBe(1);

        removeMeshLoDFromScene(scene, a);
        expect(batch.instances).toHaveLength(1);
        expect(asset.state).toBe("ready");
        expect(asset._runtime.disposed).toBe(false);
        expect(frame(engine, binding, 6)).toBe(1); // the remaining instance still renders
    });

    it("does not dispose an asset a second scene still uses when the first scene drops it", async () => {
        const server = heldServer(statueFile());
        const asset = await loadStatue(server);
        const sceneA = fakeScene(engine);
        const sceneB = fakeScene(engine);
        const instanceA = createMeshLoDInstance(asset, {} as PbrMaterialProps);
        const instanceB = createMeshLoDInstance(asset, {} as PbrMaterialProps);
        addMeshLoDToScene(sceneA, instanceA);
        addMeshLoDToScene(sceneB, instanceB);
        const bindingA = await buildBinding(engine, sceneA);
        const bindingB = await buildBinding(engine, sceneB);
        expect(frame(engine, bindingA, 6)).toBe(1);
        expect(frame(engine, bindingB, 6)).toBe(1);

        // Scene A drops its instance; scene B is untouched and the asset stays live.
        removeMeshLoDFromScene(sceneA, instanceA);
        expect(sceneA._meshLoDRegistry!.batches[0]!.instances).toHaveLength(0);
        expect(asset.state).toBe("ready");
        expect(asset._runtime.disposed).toBe(false);
        expect(frame(engine, bindingA, 6)).toBe(0); // empty batch draws nothing
        expect(frame(engine, bindingB, 6)).toBe(1); // shared asset still renders in scene B
    });
});
