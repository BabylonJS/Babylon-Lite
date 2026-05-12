/** Gaussian-Splatting render pipeline + Renderable.
 *
 *  WGSL port of the BJS `gaussianSplatting.vertex.fx` / `.fragment.fx`
 *  pair, restricted to the static splat path (no SH, no compound parts).
 *  Math is unchanged: the EWA / Vrk projection of the 3D anisotropic
 *  Gaussian is computed exactly as in BJS, then the per-fragment
 *  density `exp(-r²) * α` is multiplied with the splat colour.
 *
 *  Per-frame the binding's `update` hook:
 *    1. refreshes the per-mesh UBO (world / view / projection / focal / viewport),
 *    2. checks whether the world matrix, camera-forward (view[2,6,10]) or
 *       camera world position has drifted past `SORT_EPS` since the last sort
 *       (mirrors BJS `_isSortStateDirty`) and, if so, posts a fresh sort job,
 *    3. lets the GS-mesh `onmessage` handler upload the freshly-sorted
 *       splatIndex buffer back to the GPU.
 *
 *  The pipeline is cached per `RenderTargetSignature`. */

import type { EngineContextInternal, EngineContext } from "../engine/engine.js";
import type { SceneContext } from "../scene/scene-core.js";
import type { Renderable, DrawBinding } from "../render/renderable.js";
import type { RenderTargetSignature } from "../engine/render-target.js";
import { targetSignatureKey } from "../engine/render-target.js";
import { getViewMatrix, getProjectionMatrix, getCameraPosition } from "../camera/camera.js";
import { getSceneBindGroupLayout } from "../render/scene-helpers.js";
import { getRenderTargetSize } from "../engine/engine.js";
import { disposeGaussianSplattingMesh, type GaussianSplattingMesh } from "./gaussian-splatting-mesh.js";
import WGSL from "../../shaders/gaussian-splatting.wgsl?raw";

interface PipelineEntry {
    pipeline: GPURenderPipeline;
    meshBindGroupLayout: GPUBindGroupLayout;
}

// Per-device pipeline cache keyed by RenderTargetSignature string. Tree-shake-friendly
// lazy init (no top-level `new Map`) — see GUIDANCE §4.
let _cache: { device: GPUDevice; shaderModule: GPUShaderModule; entries: Map<string, PipelineEntry> } | null = null;

function getOrCreatePipeline(engine: EngineContextInternal, sig: RenderTargetSignature): PipelineEntry {
    const device = engine.device;
    if (!_cache || _cache.device !== device) {
        _cache = { device, shaderModule: device.createShaderModule({ code: WGSL }), entries: new Map() };
    }
    const key = targetSignatureKey(sig);
    let entry = _cache.entries.get(key);
    if (entry) {
        return entry;
    }
    const meshBindGroupLayout = device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
            { binding: 1, visibility: GPUShaderStage.VERTEX, sampler: { type: "non-filtering" } },
            { binding: 2, visibility: GPUShaderStage.VERTEX, texture: { sampleType: "unfilterable-float" } },
            { binding: 3, visibility: GPUShaderStage.VERTEX, texture: { sampleType: "unfilterable-float" } },
            { binding: 4, visibility: GPUShaderStage.VERTEX, texture: { sampleType: "unfilterable-float" } },
            { binding: 5, visibility: GPUShaderStage.VERTEX, texture: { sampleType: "unfilterable-float" } },
        ],
    });
    const pipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [getSceneBindGroupLayout(engine), meshBindGroupLayout] }),
        vertex: {
            module: _cache.shaderModule,
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
            module: _cache.shaderModule,
            entryPoint: "fs",
            targets: [
                {
                    format: sig.colorFormat,
                    blend: {
                        // BJS GS material uses ALPHA_COMBINE: src*srcAlpha + dst*(1-srcAlpha)
                        color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
                        alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
                    },
                    writeMask: GPUColorWrite.ALL,
                },
            ],
        },
        primitive: { topology: "triangle-list", cullMode: "none" },
        depthStencil: {
            format: sig.depthStencilFormat ?? "depth24plus-stencil8",
            depthCompare: "less-equal",
            depthWriteEnabled: false,
        },
        multisample: { count: sig.sampleCount },
    });
    entry = { pipeline, meshBindGroupLayout };
    _cache.entries.set(key, entry);
    return entry;
}

/** Build the Renderable for a GaussianSplattingMesh. Called from the deferred
 *  builder installed by `addToScene`. Owns the per-mesh UBO and a per-signature
 *  bind-group cache. */
export function buildGaussianSplattingRenderable(scene: SceneContext, mesh: GaussianSplattingMesh): Renderable {
    const engine = scene.engine as EngineContextInternal;
    const device = engine.device;

    const UBO_BYTES = 16 * 4 * 3 + 8 * 4; // 3 mat4 + viewport,focal,dataSize,alpha,pad → 224 bytes
    const ubo = device.createBuffer({
        size: UBO_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const cpu = new Float32Array(UBO_BYTES / 4);

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
                { binding: 1, resource: mesh._gs.sampler },
                { binding: 2, resource: mesh._gs.centersView },
                { binding: 3, resource: mesh._gs.covAView },
                { binding: 4, resource: mesh._gs.covBView },
                { binding: 5, resource: mesh._gs.colorsView },
            ],
        });
        bindGroups.set(entry.pipeline, bg);
        return bg;
    };

    // Per-element epsilon used to decide whether the camera/world state has
    // changed enough to warrant a fresh sort. Mirrors BJS `viewUpdateThreshold`
    // default (`_DefaultViewUpdateThreshold = 1e-4`).
    const SORT_EPS = 1e-4;

    const update = (): void => {
        const cam = scene.camera;
        if (!cam) {
            return;
        }
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

        // ── Sort gating ────────────────────────────────────────────
        // Mirrors BJS `_isSortStateDirty` (gaussianSplattingMeshBase.ts:849):
        // re-sort when any element of the world matrix changes, or when the
        // camera's world-space forward (view[2,6,10]) or world-space position
        // moves by more than SORT_EPS. The previous Lite gating used a single
        // `|dot - 1| ≥ 0.01` check on the modelView 3rd row, which missed
        // pure-translation moves and non-identity world matrix changes.
        if (!mesh._canPostToWorker) {
            return;
        }

        const camPos = getCameraPosition(cam);
        const cf0 = view[2]!,
            cf1 = view[6]!,
            cf2 = view[10]!;

        let dirty = false;
        const lastW = mesh._sortWorldMatrix;
        for (let i = 0; i < 16; i++) {
            if (Math.abs(lastW[i]! - world[i]!) > SORT_EPS) {
                dirty = true;
                break;
            }
        }
        if (!dirty) {
            const lastCf = mesh._sortCameraForward;
            if (Math.abs(lastCf[0]! - cf0) > SORT_EPS || Math.abs(lastCf[1]! - cf1) > SORT_EPS || Math.abs(lastCf[2]! - cf2) > SORT_EPS) {
                dirty = true;
            }
        }
        if (!dirty) {
            const lastCp = mesh._sortCameraPosition;
            if (Math.abs(lastCp[0]! - camPos.x) > SORT_EPS || Math.abs(lastCp[1]! - camPos.y) > SORT_EPS || Math.abs(lastCp[2]! - camPos.z) > SORT_EPS) {
                dirty = true;
            }
        }
        if (!dirty) {
            return;
        }

        mesh._sortWorldMatrix.set(world);
        mesh._sortCameraForward[0] = cf0;
        mesh._sortCameraForward[1] = cf1;
        mesh._sortCameraForward[2] = cf2;
        mesh._sortCameraPosition[0] = camPos.x;
        mesh._sortCameraPosition[1] = camPos.y;
        mesh._sortCameraPosition[2] = camPos.z;
        mesh._canPostToWorker = false;
        mesh._worker.postMessage(
            {
                worldMatrix: new Float32Array(world),
                cameraForward: new Float32Array([cf0, cf1, cf2]),
                cameraPosition: new Float32Array([camPos.x, camPos.y, camPos.z]),
                depthMix: mesh._depthMix,
            },
            [mesh._depthMix.buffer]
        );
    };

    const r: Renderable = {
        order: 200,
        isTransparent: true,
        bind(eng: EngineContext, sig: RenderTargetSignature): DrawBinding {
            const entry = getOrCreatePipeline(eng as EngineContextInternal, sig);
            const bindGroup = getBindGroup(entry);
            return {
                renderable: r,
                pipeline: entry.pipeline,
                update,
                draw(pass) {
                    pass.setBindGroup(1, bindGroup);
                    pass.setVertexBuffer(0, mesh._gs.quadBuffer);
                    pass.setVertexBuffer(1, mesh._gs.splatIndexBuffer);
                    pass.setIndexBuffer(mesh._gs.indexBuffer, "uint16");
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
export function attachGaussianSplattingMesh(scene: SceneContext, mesh: GaussianSplattingMesh): void {
    const ctx = scene as unknown as { _renderables: Renderable[]; _disposables: (() => void)[] };
    ctx._renderables.push(buildGaussianSplattingRenderable(scene, mesh));
    ctx._disposables.push(() => disposeGaussianSplattingMesh(mesh));
}
