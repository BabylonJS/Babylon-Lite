/** MeshLoD frame-safe lifecycle integration tests (Task 7.3 — architecture §14.1).
 *
 *  Prove that transient buffer growth and residency eviction cannot invalidate submitted
 *  work: the CPU draw-vertex buffer grows make-before-break (the old buffer is destroyed
 *  only after the retirement fence drains), and a page referenced by the current frame is
 *  never evicted under a tightened budget until it goes unreferenced and its fence drains
 *  (REQ-RENDER-4). Driven CPU-side against a delivering range server + fill decoder + mock
 *  device; real WebGPU pixels are covered by the browser harness. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addMeshLoDToScene, createMeshLoDInstance, loadMeshLoD, setMeshLoDCacheBudget } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod.js";
import { _setMeshLoDPageDecoder } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-page-decoder.js";
import type { MeshLoDAsset } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod.js";
import type { SceneContext } from "../../../../packages/babylon-lite/src/scene/scene-core.js";
import type { Camera } from "../../../../packages/babylon-lite/src/camera/camera.js";
import type { PbrMaterialProps } from "../../../../packages/babylon-lite/src/material/pbr/pbr-material.js";
import type { EngineContext } from "../../../../packages/babylon-lite/src/engine/engine.js";
import type { RenderTargetSignature } from "../../../../packages/babylon-lite/src/engine/render-target.js";
import type { DrawBinding } from "../../../../packages/babylon-lite/src/render/renderable.js";
import { createFillDecoder, createMockEngine, createMockRenderPass } from "../../unit/mesh-lod/fixtures/gpu-mock.js";
import type { MockBuffer } from "../../unit/mesh-lod/fixtures/gpu-mock.js";

const STATUE = fileURLToPath(new URL("../../../../lab/public/mesh-lod/harvard-yenching_institute_statue.mesh000.prim000.mlod", import.meta.url));
const SIG: RenderTargetSignature = { _colorFormat: "rgba8unorm", _depthStencilFormat: "depth24plus-stencil8", _sampleCount: 1 };

function statueFile(): Uint8Array {
    return new Uint8Array(readFileSync(STATUE));
}
function bufferOf(bytes: Uint8Array): ArrayBuffer {
    return bytes.slice().buffer as ArrayBuffer;
}

/** A range server that serves every range (coarse + fine) immediately with a 206 slice. */
function deliverServer(file: Uint8Array): typeof globalThis.fetch {
    return (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const range = new Headers(init?.headers).get("Range");
        if (!range) {
            return new Response(bufferOf(file), { status: 200, headers: { "Content-Length": String(file.length) } });
        }
        const m = /^bytes=(\d+)-(\d+)$/.exec(range)!;
        const start = Number(m[1]);
        const end = Math.min(Number(m[2]), file.length - 1);
        return new Response(bufferOf(file.subarray(start, end + 1)), {
            status: 206,
            headers: { "Content-Range": `bytes ${start}-${end}/${file.length}`, "Content-Length": String(end - start + 1) },
        });
    }) as typeof globalThis.fetch;
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

let engine: EngineContext;

interface Harness {
    asset: MeshLoDAsset;
    scene: SceneContext;
    binding: DrawBinding;
    packet(): { drawVertexBuffer: MockBuffer };
    frame(dist: number): void;
    submit(): void;
    settle(): Promise<void>;
}

async function setup(options?: { residencyHoldFrames?: number }): Promise<Harness> {
    const asset = await loadMeshLoD(engine, "https://cdn.test/statue.mlod", {
        selectionMode: "cpu",
        residencyHoldFrames: options?.residencyHoldFrames ?? 2,
        request: { fetch: deliverServer(statueFile()) },
    });
    const scene = fakeScene(engine);
    addMeshLoDToScene(scene, createMeshLoDInstance(asset, {} as PbrMaterialProps));
    for (const builder of scene._deferredBuilders) {
        await builder();
    }
    const binding = scene._renderables[0]!.bind(engine, SIG);
    const batch = scene._meshLoDRegistry!.batches[0]!;
    return {
        asset,
        scene,
        binding,
        packet: () => (batch as { _packet: { drawVertexBuffer: MockBuffer } })._packet,
        frame(dist: number): void {
            binding.update!({ targetWidth: 1280, targetHeight: 720, _camera: cameraAt(dist) });
            binding.draw(createMockRenderPass() as unknown as GPURenderPassEncoder, engine);
        },
        submit(): void {
            const retirements = engine._retirements;
            engine._retirements = null;
            retirements?.forEach((r) => r());
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
    engine = createMockEngine().engine;
});
afterEach(() => {
    _setMeshLoDPageDecoder(null);
});

describe("MeshLoD frame-safe lifecycle", () => {
    it("grows the CPU draw-vertex buffer make-before-break — the old buffer retires only after the fence", async () => {
        const h = await setup();
        const initialBuffer = h.packet().drawVertexBuffer;
        let grown: MockBuffer | null = null;

        // Stream fine detail in until the refined selection outgrows the coarse draw buffer.
        for (let i = 0; i < 24 && !grown; i++) {
            h.frame(2); // update may grow the draw buffer (before submit)
            const current = h.packet().drawVertexBuffer;
            if (current !== initialBuffer) {
                grown = initialBuffer;
                break;
            }
            await h.settle();
            h.submit();
        }

        expect(grown).not.toBeNull();
        // Make-before-break: the replacement is live, the old buffer is NOT destroyed yet.
        expect(grown!.destroyed).toBe(false);
        expect(h.packet().drawVertexBuffer).not.toBe(grown);
        expect(engine._retirements?.length ?? 0).toBeGreaterThan(0);

        // Only after the submitted frame's fence drains is the old buffer destroyed.
        h.submit();
        expect(grown!.destroyed).toBe(true);
        expect(h.asset.diagnostics.renderedTriangleCount).toBeGreaterThan(46); // rendered the refined geometry
    });

    it("never evicts a page referenced by the current frame under a tightened budget", async () => {
        const h = await setup({ residencyHoldFrames: 0 }); // isolate frame-ref protection from the LRU hold
        // Stream fine pages resident with a close camera.
        for (let i = 0; i < 10; i++) {
            h.frame(3);
            await h.settle();
            h.submit();
        }
        const runtime = h.asset._runtime;
        expect(runtime.gpu.residentPageCount).toBeGreaterThan(1);
        const residentFine = runtime.gpu.pages.filter((p) => p.state === "gpu-resident" && !runtime.pageRecords[p.id]!.pinned).length;
        expect(residentFine).toBeGreaterThan(0);

        // Tighten the budget so only the pinned page fits — yet a referenced frame keeps the
        // fine pages resident: they hold a current-frame reference and cannot be evicted.
        setMeshLoDCacheBudget(h.asset, 64 * 1024);
        h.frame(3); // still framed close → fine clusters are selected → their pages are referenced
        const stillResidentFine = runtime.gpu.pages.filter((p) => p.state === "gpu-resident" && !runtime.pageRecords[p.id]!.pinned).length;
        expect(stillResidentFine).toBeGreaterThan(0); // protected despite the tight budget

        // Once unreferenced (camera pulled far) and the fences drain, the budget trim evicts them.
        for (let i = 0; i < 4; i++) {
            h.frame(400);
            h.submit();
        }
        expect(runtime.gpu.pages.filter((p) => p.state === "gpu-resident" && !runtime.pageRecords[p.id]!.pinned).length).toBe(0);
    });
});
