/** Gaussian-Splatting render pipeline + Renderable.
 *
 *  WGSL port of the BJS `gaussianSplatting.vertex.fx` / `.fragment.fx`
 *  pair, restricted to the static splat path (no SH, no compound parts).
 *  Math is unchanged: the EWA / Vrk projection of the 3D anisotropic
 *  Gaussian is computed exactly as in BJS, then the per-fragment
 *  density `exp(-r²) * α` is multiplied with the splat colour.
 *
 *  Per-frame the binding's `update` hook:
 *    1. uploads the latest sorted splatIndex order received from the worker
 *       (`uploadPendingSplatOrder` — at most one upload per frame, stale
 *       results are dropped),
 *    2. refreshes the per-mesh UBO (world / view / projection / focal / viewport),
 *    3. posts a fresh sort job when the camera/world state drifted past the
 *       re-sort epsilon and an order buffer is free (`postSplatSortIfDirty` —
 *       shared with the SH pipeline, see gaussian-splatting-mesh.ts).
 *
 *  The pipeline is cached per `RenderTargetSignature`. */

import { F32 } from "../../engine/typed-arrays.js";
import { BU, SS, CW } from "../../engine/gpu-flags.js";
import type { EngineContext } from "../../engine/engine.js";
import type { SceneContext } from "../../scene/scene-core.js";
import type { Renderable, DrawBinding } from "../../render/renderable.js";
import type { RenderTargetSignature } from "../../engine/render-target.js";
import { targetSignatureKey } from "../../engine/render-target-signature.js";
import { getViewMatrix, getProjectionMatrix } from "../../camera/camera.js";
import { getSceneBindGroupLayout } from "../../render/scene-helpers.js";
import { getRenderTargetSize } from "../../engine/engine.js";
import { disposeGaussianSplattingMesh, uploadPendingSplatOrder, postSplatSortIfDirty, type GaussianSplattingMesh, type GsShaderFragment } from "./gaussian-splatting-mesh.js";
import { registerPickSource } from "../../picking/pick-contributor.js";
import { applyGsFragments } from "./gs-apply-fragments.js";
import WGSL from "../../../shaders/gaussian-splatting.wgsl?raw";

interface PipelineEntry {
    pipeline: GPURenderPipeline;
    meshBindGroupLayout: GPUBindGroupLayout;
}

// Per-device pipeline cache keyed by RenderTargetSignature string. Tree-shake-friendly
// lazy init (no top-level `new Map`) — see GUIDANCE §4.
let _cache: { device: GPUDevice; modules: Map<string, GPUShaderModule>; entries: Map<string, PipelineEntry> } | null = null;

function getOrCreatePipeline(engine: EngineContext, sig: RenderTargetSignature, fragments?: readonly GsShaderFragment[]): PipelineEntry {
    const device = engine._device;
    if (!_cache || _cache.device !== device) {
        _cache = { device, modules: new Map(), entries: new Map() };
    }
    const fragKey = fragments && fragments.length > 0 ? "|" + fragments.map((f) => f.id).join(",") : "";
    const key = targetSignatureKey(sig) + fragKey;
    let entry = _cache.entries.get(key);
    if (entry) {
        return entry;
    }
    let module = _cache.modules.get(fragKey);
    if (!module) {
        module = device.createShaderModule({ code: fragments && fragments.length > 0 ? applyGsFragments(WGSL, fragments) : WGSL });
        _cache.modules.set(fragKey, module);
    }
    const meshBindGroupLayout = device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: SS.VERTEX | SS.FRAGMENT, buffer: { type: "uniform" } },
            { binding: 1, visibility: SS.VERTEX, sampler: { type: "non-filtering" } },
            { binding: 2, visibility: SS.VERTEX, texture: { sampleType: "unfilterable-float" } },
            { binding: 3, visibility: SS.VERTEX, texture: { sampleType: "unfilterable-float" } },
            { binding: 4, visibility: SS.VERTEX, texture: { sampleType: "unfilterable-float" } },
            { binding: 5, visibility: SS.VERTEX, texture: { sampleType: "unfilterable-float" } },
        ],
    });
    const pipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [getSceneBindGroupLayout(engine), meshBindGroupLayout] }),
        vertex: {
            module,
            entryPoint: "vs",
            buffers: [
                {
                    arrayStride: 8,
                    stepMode: "vertex",
                    attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
                },
                {
                    arrayStride: 4,
                    stepMode: "instance",
                    attributes: [{ shaderLocation: 1, offset: 0, format: "float32" }],
                },
            ],
        },
        fragment: {
            module,
            entryPoint: "fs",
            targets: [
                {
                    format: sig._colorFormat!,
                    blend: {
                        // BJS GS material uses ALPHA_COMBINE: src*srcAlpha + dst*(1-srcAlpha)
                        color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
                        alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
                    },
                    writeMask: CW.ALL,
                },
            ],
        },
        primitive: { topology: "triangle-list", cullMode: "none" },
        depthStencil: {
            format: sig._depthStencilFormat ?? "depth24plus-stencil8",
            depthCompare: sig._depthCompare ?? "greater-equal",
            depthWriteEnabled: false,
        },
        multisample: { count: sig._sampleCount },
    });
    entry = { pipeline, meshBindGroupLayout };
    _cache.entries.set(key, entry);
    return entry;
}

/** Build the Renderable for a GaussianSplattingMesh. Called from the deferred
 *  builder installed by `addToScene`. Owns the per-mesh UBO and a per-signature
 *  bind-group cache. */
export function buildGaussianSplattingRenderable(scene: SceneContext, mesh: GaussianSplattingMesh, fragments?: readonly GsShaderFragment[]): Renderable {
    const engine = scene.surface.engine;
    const device = engine._device;

    const UBO_BYTES = 16 * 4 * 3 + 8 * 4; // 3 mat4 + viewport,focal,dataSize,alpha,pad → 224 bytes
    const ubo = device.createBuffer({
        size: UBO_BYTES,
        usage: BU.UNIFORM | BU.COPY_DST,
    });
    const cpu = new F32(UBO_BYTES / 4);

    // dataSize is constant for the lifetime of this mesh; pre-write it.
    cpu[48 + 4] = mesh.textureWidth;
    cpu[48 + 5] = mesh.textureHeight;
    cpu[48 + 6] = 1; // alpha
    cpu[48 + 7] = 0; // pad

    // One per-mesh bind group per pipeline (== per RenderTargetSignature).
    const bindGroups = new Map<GPURenderPipeline, GPUBindGroup>();

    const getBindGroup = (entry: PipelineEntry): GPUBindGroup => {
        let bg = bindGroups.get(entry.pipeline);
        if (bg) {
            return bg;
        }
        bg = device.createBindGroup({
            layout: entry.meshBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: ubo } },
                { binding: 1, resource: mesh._gs._sampler },
                { binding: 2, resource: mesh._gs._centersView },
                { binding: 3, resource: mesh._gs._covAView },
                { binding: 4, resource: mesh._gs._covBView },
                { binding: 5, resource: mesh._gs._colorsView },
            ],
        });
        bindGroups.set(entry.pipeline, bg);
        return bg;
    };

    const update = (): void => {
        const cam = scene.camera;
        if (!cam) {
            return;
        }
        uploadPendingSplatOrder(device.queue, mesh);

        const size = getRenderTargetSize(engine);
        const aspect = size.width / size.height;
        const view = getViewMatrix(cam) as unknown as Float32Array;
        const proj = getProjectionMatrix(cam, aspect) as unknown as Float32Array;
        const world = mesh.worldMatrix as unknown as Float32Array;

        cpu.set(world, 0);
        cpu.set(view, 16);
        cpu.set(proj, 32);
        cpu[48] = size.width;
        cpu[48 + 1] = size.height;
        cpu[48 + 2] = size.width * 0.5 * proj[0]!;
        cpu[48 + 3] = size.height * 0.5 * proj[5]!;
        // dataSize / alpha pre-written at construction.
        device.queue.writeBuffer(ubo, 0, cpu.buffer, 0, UBO_BYTES);

        postSplatSortIfDirty(mesh, world, view);
    };

    const r: Renderable = {
        order: 200,
        isTransparent: true,
        bind(eng: EngineContext, sig: RenderTargetSignature): DrawBinding {
            const entry = getOrCreatePipeline(eng, sig, fragments);
            const bindGroup = getBindGroup(entry);
            return {
                renderable: r,
                pipeline: entry.pipeline,
                update,
                draw(pass) {
                    pass.setBindGroup(1, bindGroup);
                    pass.setVertexBuffer(0, mesh._gs._quadBuffer);
                    pass.setVertexBuffer(1, mesh._gs._splatIndexBuffer);
                    pass.setIndexBuffer(mesh._gs._indexBuffer, "uint16");
                    pass.drawIndexed(6, mesh.vertexCount);
                    return 1;
                },
            };
        },
    };
    return r;
}

/** Wire a `GaussianSplattingMesh` into a scene: pushes its renderable +
 *  registers a disposer that frees per-mesh GPU buffers and the worker.
 *  Called from the deferred builder installed by `addToScene`. */
export function attachGaussianSplattingMesh(scene: SceneContext, mesh: GaussianSplattingMesh, fragments?: readonly GsShaderFragment[]): void {
    const ctx = scene as unknown as { _renderables: Renderable[]; _disposables: (() => void)[] };
    ctx._renderables.push(buildGaussianSplattingRenderable(scene, mesh, fragments));
    const unregisterPick = registerPickSource(scene, mesh, () => import("../../picking/gs-picking-pipeline.js"));
    ctx._disposables.push(() => {
        unregisterPick();
        disposeGaussianSplattingMesh(mesh);
    });
}
