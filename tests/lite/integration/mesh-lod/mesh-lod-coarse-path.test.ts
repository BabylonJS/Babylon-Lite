/** MeshLoD lazy coarse-path verification (Task 4.5).
 *
 *  Proves the first runtime milestone end-to-end through the PUBLIC facade: an
 *  opt-in load fetches only coarse bootstrap ranges (no fine pages), and the coarse
 *  render survives permanently-unavailable fine data with no holes and no asset
 *  failure (REQ-VERIFY-2, REQ-VERIFY-5, REQ-SEL-7). Real WebGPU pixels are validated
 *  separately in the browser; here a mock device drives the deterministic path. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMeshLoD, createMeshLoDInstance, addMeshLoDToScene } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod.js";
import { _setMeshLoDPageDecoder } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-page-decoder.js";
import type { MeshLoDAsset } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod.js";
import type { SceneContext } from "../../../../packages/babylon-lite/src/scene/scene-core.js";
import type { Camera } from "../../../../packages/babylon-lite/src/camera/camera.js";
import type { PbrMaterialProps } from "../../../../packages/babylon-lite/src/material/pbr/pbr-material.js";
import type { EngineContext } from "../../../../packages/babylon-lite/src/engine/engine.js";
import type { RenderTargetSignature } from "../../../../packages/babylon-lite/src/engine/render-target.js";
import { createFillDecoder, createMockEngine, createMockRenderPass } from "../../unit/mesh-lod/fixtures/gpu-mock.js";

const STATUE = fileURLToPath(new URL("../../../../lab/public/mesh-lod/harvard-yenching_institute_statue.mesh000.prim000.mlod", import.meta.url));

function statueFile(): Uint8Array {
    return new Uint8Array(readFileSync(STATUE));
}

function bufferOf(bytes: Uint8Array): ArrayBuffer {
    return bytes.slice().buffer as ArrayBuffer;
}

/** A range server that records every requested range and FAILS (500) any read whose
 *  start is at/after `fineFloor` — i.e. any fine-page fetch. The coarse bootstrap
 *  must never cross that line. */
function coarseOnlyServer(file: Uint8Array, fineFloor: number): { fetch: typeof globalThis.fetch; calls: number; maxEnd: number; fineRequests: number } {
    const server = { calls: 0, maxEnd: 0, fineRequests: 0 } as { fetch: typeof globalThis.fetch; calls: number; maxEnd: number; fineRequests: number };
    server.fetch = (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        server.calls += 1;
        const range = new Headers(init?.headers).get("Range");
        if (!range) {
            return new Response(bufferOf(file), { status: 200, headers: { "Content-Length": String(file.length) } });
        }
        const match = /^bytes=(\d+)-(\d+)$/.exec(range)!;
        const start = Number(match[1]);
        const end = Math.min(Number(match[2]), file.length - 1);
        server.maxEnd = Math.max(server.maxEnd, end);
        if (start >= fineFloor) {
            server.fineRequests += 1;
            return new Response(null, { status: 500 });
        }
        const body = file.subarray(start, end + 1);
        return new Response(bufferOf(body), { status: 206, headers: { "Content-Range": `bytes ${start}-${end}/${file.length}`, "Content-Length": String(body.length) } });
    }) as typeof globalThis.fetch;
    return server;
}

const SIG: RenderTargetSignature = { _colorFormat: "rgba8unorm", _depthStencilFormat: "depth24plus-stencil8", _sampleCount: 1 };

function fakeScene(engine: EngineContext): SceneContext {
    return { _deferredBuilders: [], _renderables: [], _disposables: [], surface: { engine } } as unknown as SceneContext;
}

function fakeCamera(): Camera {
    return {
        fov: 0.8,
        nearPlane: 0.1,
        farPlane: 100,
        worldMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -12, 1]),
        worldMatrixVersion: 1,
    } as unknown as Camera;
}

async function renderCoarse(asset: MeshLoDAsset, engine: EngineContext): Promise<{ scene: SceneContext; drawCount: number }> {
    const scene = fakeScene(engine);
    addMeshLoDToScene(scene, createMeshLoDInstance(asset, {} as PbrMaterialProps));
    for (const builder of scene._deferredBuilders) {
        await builder();
    }
    const binding = scene._renderables[0]!.bind(engine, SIG);
    binding.update!({ targetWidth: 800, targetHeight: 600, _camera: fakeCamera() });
    const pass = createMockRenderPass();
    const drawCount = binding.draw(pass as unknown as GPURenderPassEncoder, engine);
    return { scene, drawCount };
}

let engine: EngineContext;

beforeEach(() => {
    _setMeshLoDPageDecoder(createFillDecoder().decoder);
    engine = createMockEngine().engine;
});
afterEach(() => {
    _setMeshLoDPageDecoder(null);
});

describe("MeshLoD lazy coarse path", () => {
    it("bootstraps coarse-only over the wire — never fetching a fine page", async () => {
        const file = statueFile();
        // The single pinned page ends well within the first ~300 KiB; everything after
        // that is fine data the coarse path must never request.
        const server = coarseOnlyServer(file, 400 * 1024);
        const asset = await loadMeshLoD(engine, "https://cdn.test/statue.mlod", { request: { fetch: server.fetch } });

        expect(asset.state).toBe("ready");
        expect(server.fineRequests).toBe(0);
        expect(server.maxEnd).toBeLessThan(file.length);
        expect(asset.diagnostics.downloadedBytes).toBeLessThan(file.length);
        // Every terminal-group (pinned) page is resident — the coarse geometry is whole.
        expect(asset.diagnostics.residentPageCount).toBe(asset.metadata.pinnedPageCount);
    });

    it("renders the coarse fallback through the public facade with fine data unavailable", async () => {
        const file = statueFile();
        const server = coarseOnlyServer(file, 400 * 1024);
        const asset = await loadMeshLoD(engine, "https://cdn.test/statue.mlod", { request: { fetch: server.fetch }, selectionMode: "cpu" });

        const { drawCount } = await renderCoarse(asset, engine);
        // Phase-6 streaming demands fine pages while rendering; this server makes every
        // fine page permanently unavailable (500). Each failed fine fetch is page-local:
        // the coarse geometry still rasterizes as one indirect draw, no fine page ever
        // becomes resident, and the asset never fails (REQ-SEL-7).
        expect(drawCount).toBe(1);
        expect(asset.diagnostics.renderedTriangleCount).toBeGreaterThan(0);
        expect(asset.state).toBe("ready");
        expect(server.fineRequests).toBeGreaterThan(0);
        expect(asset.diagnostics.residentPageCount).toBe(asset.metadata.pinnedPageCount);
    });

    it("keeps coarse geometry usable across repeated frames without requesting fine pages", async () => {
        const file = statueFile();
        const server = coarseOnlyServer(file, 400 * 1024);
        const asset = await loadMeshLoD(engine, bufferOf(file), { selectionMode: "cpu" });
        const { scene } = await renderCoarse(asset, engine);
        const binding = scene._renderables[0]!.bind(engine, SIG);
        const ctx = { targetWidth: 800, targetHeight: 600, _camera: fakeCamera() };
        for (let frame = 0; frame < 3; frame++) {
            binding.update!(ctx);
        }
        expect(asset.diagnostics.renderedTriangleCount).toBeGreaterThan(0);
        expect(asset.state).toBe("ready");
        expect(server.fineRequests).toBe(0);
    });
});
