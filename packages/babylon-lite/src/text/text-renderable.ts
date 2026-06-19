/** TextRenderable — a scene-attachable text entity backed by a TextData.
 *  Mirrors Mesh's TRS surface (position/rotation/rotationQuaternion/scaling). */

import type { EngineContext } from "../engine/engine.js";
import type { RenderTargetSignature } from "../engine/render-target.js";
import type { DrawBinding, DrawUpdateContext, Renderable } from "../render/renderable.js";
import { ObservableVec3 } from "../math/observable-vec3.js";
import { ObservableQuat } from "../math/observable-quat.js";
import { createWorldMatrixState } from "../scene/world-matrix-state.js";
import { createEulerProxy } from "../scene/scene-node.js";
import type { EulerProxy } from "../scene/scene-node.js";
import { mat4Compose } from "../math/mat4-compose.js";
import { mat4Identity } from "../math/mat4-identity.js";
import { createEmptyUniformBuffer } from "../resource/gpu-buffers.js";
import { addDeferredSceneRenderables } from "../scene/scene-core.js";
import type { SceneContext } from "../scene/scene-core.js";
import type { Mat4, Mat4Storage, Vec3 } from "../math/types.js";
import { mat4MultiplyInto } from "../math/mat4-multiply-into.js";
import { getViewProjectionMatrix, getEffectiveAspectRatio } from "../camera/camera.js";
import type { TextData } from "./text-data.js";
import { TEXT_INSTANCE_BYTES } from "./text-data.js";
import { ensureSharedAtlasGpu } from "./_gpu/text-textures.js";
import { getOrCreateTextPipeline } from "./_gpu/text-pipeline.js";

/** Initial transform and draw options for a scene-attached text renderable. */
export interface TextRenderableOptions {
    readonly position?: Readonly<Vec3>;
    readonly rotationQuaternion?: { readonly x: number; readonly y: number; readonly z: number; readonly w: number };
    readonly scaling?: Readonly<Vec3>;
    /** Whole-block opacity in [0,1]. Default 1. Per-glyph/per-run color comes from the `TextData`
     *  descriptor (`PlacedGlyph.color` / `GlyphRun.defaultColor`), not from the renderable. */
    readonly opacity?: number;
    readonly ignoreDepth?: boolean;
    readonly order?: number;
}

/** Scene renderable that draws a `TextData` block with mesh-like transform controls. */
export interface TextRenderable extends Renderable {
    /** @internal */
    readonly _entityType: "text";
    readonly position: ObservableVec3;
    readonly rotation: EulerProxy;
    readonly rotationQuaternion: ObservableQuat;
    readonly scaling: ObservableVec3;
    /** Whole-block opacity in [0,1]. Color is supplied per-glyph by the `TextData` descriptor. */
    opacity: number;
    ignoreDepth: boolean;
    order: number;
    /** @internal */ readonly _data: TextData;
    /** @internal */ readonly _worldMatrix: () => Mat4;
    /** @internal */ _wmDirty: boolean;
    /** @internal */ _gpu: TextRenderableGpu | null;
    /** @internal */ _version: number;
}

interface TextRenderableGpu {
    device: GPUDevice;
    textU: GPUBuffer;
    instanceBuf: GPUBuffer;
    instanceCap: number;
    pipeline: GPURenderPipeline;
    uploadedDataVersion: number;
    uploadedCameraVersion: number;
    uploadedAspect: number;
    uploadedViewportW: number;
    uploadedViewportH: number;
    uploadedOpacity: number;
    targetKey: string;
}

const TEXT_UBO_BYTES = 64 /* mvp */ + 16 /* viewport */ + 16; /* color */
const _mvpScratch = new Float32Array(16);

function targetSig(target: RenderTargetSignature): string {
    return (target._colorFormat ?? "-") + ":" + (target._sampleCount ?? 1) + ":" + (target._depthStencilFormat ?? "-");
}

/** Create a scene renderable that draws the supplied `TextData` through the normal renderable pipeline.
 *
 *  @param data - Text data block to render.
 *  @param options - Optional transform, opacity, depth, and ordering settings.
 *  @returns A transparent renderable suitable for adding to a scene. */
export function createTextRenderable(data: TextData, options?: TextRenderableOptions): TextRenderable {
    const pos = options?.position;
    const rq = options?.rotationQuaternion;
    const sc = options?.scaling;
    const initRq = rq ?? { x: 0, y: 0, z: 0, w: 1 };

    const wm = createWorldMatrixState(() => {
        const p = r.position;
        const q = r.rotationQuaternion;
        const s = r.scaling;
        const isIdentity = p.x === 0 && p.y === 0 && p.z === 0 && q.x === 0 && q.y === 0 && q.z === 0 && q.w === 1 && s.x === 1 && s.y === 1 && s.z === 1;
        return isIdentity ? mat4Identity() : mat4Compose(p.x, p.y, p.z, q.x, q.y, q.z, q.w, s.x, s.y, s.z);
    });
    const markDirty = (): void => {
        r._wmDirty = true;
        wm.markLocalDirty();
    };
    const quat = new ObservableQuat(initRq.x, initRq.y, initRq.z, initRq.w, markDirty);

    const r: TextRenderable = {
        _entityType: "text",
        order: options?.order ?? 200,
        isTransparent: true,
        position: new ObservableVec3(pos?.x ?? 0, pos?.y ?? 0, pos?.z ?? 0, markDirty),
        rotationQuaternion: quat,
        rotation: createEulerProxy(quat),
        scaling: new ObservableVec3(sc?.x ?? 1, sc?.y ?? 1, sc?.z ?? 1, markDirty),
        opacity: options?.opacity ?? 1,
        ignoreDepth: options?.ignoreDepth ?? false,
        _data: data,
        _wmDirty: true,
        _gpu: null,
        _version: 0,
        _worldMatrix: () => wm.getWorldMatrix(),
        bind(engine, target): DrawBinding {
            return bindTextRenderable(r, engine, target);
        },
    };
    return r;
}

function ensureGpu(r: TextRenderable, engine: EngineContext, target: RenderTargetSignature): TextRenderableGpu {
    const device = engine._device;
    const sampleCount = target._sampleCount === 1 ? 1 : 4;
    const colorFormat = target._colorFormat;
    if (!colorFormat) {
        throw new Error("TextRenderable: render target has no color format.");
    }
    const depthFormat = target._depthStencilFormat ?? null;
    const depthWrite = !r.ignoreDepth;
    const { pipeline } = getOrCreateTextPipeline(engine, colorFormat, sampleCount, depthFormat, depthWrite);
    const key = targetSig(target);
    let gpu = r._gpu;
    if (gpu && gpu.device !== device) {
        gpu.textU.destroy();
        gpu.instanceBuf.destroy();
        gpu = null;
    }
    if (!gpu || gpu.targetKey !== key || gpu.pipeline !== pipeline) {
        if (!gpu) {
            const cap = Math.max(r._data._instanceCount, 8);
            gpu = {
                device,
                textU: createEmptyUniformBuffer(engine, TEXT_UBO_BYTES, "text-renderable-ubo"),
                instanceBuf: device.createBuffer({
                    label: "text-instance",
                    size: cap * TEXT_INSTANCE_BYTES,
                    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
                }),
                instanceCap: cap,
                pipeline,
                uploadedDataVersion: -1,
                uploadedCameraVersion: -1,
                uploadedAspect: -1,
                uploadedViewportW: 0,
                uploadedViewportH: 0,
                uploadedOpacity: NaN,
                targetKey: key,
            };
            r._gpu = gpu;
        } else {
            gpu.pipeline = pipeline;
            gpu.targetKey = key;
            // Pipeline change — per-group bind groups must be rebuilt against the new bindGroupLayout.
            for (const g of r._data._groups) {
                g.bindGroup = null;
                g.bindGroupVersion = -1;
            }
        }
    }
    return gpu;
}

function ensureInstanceCapacity(device: GPUDevice, gpu: TextRenderableGpu, needed: number): void {
    if (needed <= gpu.instanceCap) {
        return;
    }
    let cap = gpu.instanceCap;
    while (cap < needed) {
        cap *= 2;
    }
    gpu.instanceBuf.destroy();
    gpu.instanceBuf = device.createBuffer({
        label: "text-instance",
        size: cap * TEXT_INSTANCE_BYTES,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    gpu.instanceCap = cap;
    gpu.uploadedDataVersion = -1;
}

function bindTextRenderable(r: TextRenderable, engine: EngineContext, target: RenderTargetSignature): DrawBinding {
    const gpu = ensureGpu(r, engine, target);
    const { cache } = getOrCreateTextPipeline(engine, target._colorFormat!, target._sampleCount === 1 ? 1 : 4, target._depthStencilFormat ?? null, !r.ignoreDepth);
    const quadVertex = cache.quadVertexBuffer;
    const bindGroupLayout = cache.bindGroupLayout;

    return {
        renderable: r,
        pipeline: gpu.pipeline,
        update(context: DrawUpdateContext): void {
            updateTextRenderable(r, engine, gpu, bindGroupLayout, context);
        },
        draw(pass): number {
            return drawTextRenderable(gpu, r._data, quadVertex, pass);
        },
    };
}

function updateTextRenderable(r: TextRenderable, engine: EngineContext, gpu: TextRenderableGpu, bindGroupLayout: GPUBindGroupLayout, context: DrawUpdateContext): void {
    const device = engine._device;
    const data = r._data;

    // Sync every group's atlas to the GPU; track which need bind-group rebuild.
    for (const g of data._groups) {
        const { rebuilt, gpu: atlasGpu } = ensureSharedAtlasGpu(device, g.curveSet.atlas);
        if (rebuilt || !g.bindGroup || g.bindGroupVersion !== atlasGpu.uploadedVersion) {
            g.bindGroup = device.createBindGroup({
                label: "text-bg0-" + g.curveSetId,
                layout: bindGroupLayout,
                entries: [
                    { binding: 0, resource: { buffer: gpu.textU } },
                    { binding: 1, resource: atlasGpu.curveTex.createView() },
                    { binding: 2, resource: atlasGpu.bandTex.createView() },
                ],
            });
            g.bindGroupVersion = atlasGpu.uploadedVersion;
        }
    }

    // Sync instance buffer if data changed.
    ensureInstanceCapacity(device, gpu, data._instanceCount);
    if (gpu.uploadedDataVersion !== data._version) {
        if (data._instanceCount > 0) {
            // Partial upload when only a sub-range is dirty; full upload after grow/reset (when
            // uploadedDataVersion is -1 we don't trust the dirty range).
            const dirtyValid = gpu.uploadedDataVersion !== -1 && data._dirtyEnd > data._dirtyStart;
            if (dirtyValid) {
                const startFloats = data._dirtyStart * (TEXT_INSTANCE_BYTES / 4);
                const endFloats = data._dirtyEnd * (TEXT_INSTANCE_BYTES / 4);
                const view = data._instances.subarray(startFloats, endFloats);
                device.queue.writeBuffer(gpu.instanceBuf, data._dirtyStart * TEXT_INSTANCE_BYTES, view.buffer as ArrayBuffer, view.byteOffset, view.byteLength);
            } else {
                const view = data._instances.subarray(0, data._instanceCount * (TEXT_INSTANCE_BYTES / 4));
                device.queue.writeBuffer(gpu.instanceBuf, 0, view.buffer as ArrayBuffer, view.byteOffset, view.byteLength);
            }
        }
        gpu.uploadedDataVersion = data._version;
        data._dirtyStart = 0;
        data._dirtyEnd = 0;
    }

    // Sync text UBO: mvp (vp * world) + viewport + color. The scene UBO is no longer
    // consumed by the text pipeline, so we compose the mvp here from the active camera.
    // Skip the recompute + upload when the world matrix, camera, and aspect are all unchanged.
    const camera = context._camera ?? null;
    if (camera) {
        const aspect = getEffectiveAspectRatio(camera, context.targetWidth, context.targetHeight);
        const camVer = camera.worldMatrixVersion;
        if (r._wmDirty || gpu.uploadedCameraVersion !== camVer || gpu.uploadedAspect !== aspect) {
            const vp = getViewProjectionMatrix(camera, aspect) as unknown as Float32Array;
            const wm = r._worldMatrix();
            mat4MultiplyInto(_mvpScratch, 0, vp, 0, wm as unknown as Mat4Storage, 0);
            device.queue.writeBuffer(gpu.textU, 0, _mvpScratch.buffer as ArrayBuffer, _mvpScratch.byteOffset, 64);
            r._wmDirty = false;
            gpu.uploadedCameraVersion = camVer;
            gpu.uploadedAspect = aspect;
        }
    }
    if (gpu.uploadedViewportW !== context.targetWidth || gpu.uploadedViewportH !== context.targetHeight) {
        const vp = new Float32Array([context.targetWidth, context.targetHeight, 0, 0]);
        device.queue.writeBuffer(gpu.textU, 64, vp.buffer as ArrayBuffer, vp.byteOffset, 16);
        gpu.uploadedViewportW = context.targetWidth;
        gpu.uploadedViewportH = context.targetHeight;
    }
    // Color uniform carries whole-block opacity as alpha (rgb fixed to white). Per-glyph color
    // comes from the instance `slugColor` attribute.
    if (gpu.uploadedOpacity !== r.opacity) {
        const col = new Float32Array([1, 1, 1, r.opacity]);
        device.queue.writeBuffer(gpu.textU, 80, col.buffer as ArrayBuffer, col.byteOffset, 16);
        gpu.uploadedOpacity = r.opacity;
    }
}

function drawTextRenderable(gpu: TextRenderableGpu, data: TextData, quadVertex: GPUBuffer, pass: GPURenderPassEncoder | GPURenderBundleEncoder): number {
    if (data._instanceCount === 0) {
        return 0;
    }
    pass.setVertexBuffer(0, quadVertex);
    pass.setVertexBuffer(1, gpu.instanceBuf);
    let draws = 0;
    for (const g of data._groups) {
        if (g.slotCount === 0 || !g.bindGroup) {
            continue;
        }
        pass.setBindGroup(0, g.bindGroup);
        pass.draw(6, g.slotCount, 0, g.slotStart);
        draws++;
    }
    return draws;
}

/** Release GPU buffers owned by a text renderable. The underlying `TextData` and `GlyphStorage` remain caller-owned. */
export function disposeTextRenderable(renderable: TextRenderable): void {
    if (renderable._gpu) {
        renderable._gpu.textU.destroy();
        renderable._gpu.instanceBuf.destroy();
        renderable._gpu = null;
    }
}

/** Attach a `TextRenderable` to a scene. Uses the scene's deferred-renderables hook. */
export function addTextRenderable(scene: SceneContext, renderable: TextRenderable): void {
    addDeferredSceneRenderables(scene, () => {
        return {
            renderables: [renderable],
            dispose: () => disposeTextRenderable(renderable),
        };
    });
}
