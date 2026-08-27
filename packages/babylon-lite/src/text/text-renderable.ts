/** TextRenderable — a scene-attachable text entity backed by a TextData.
 *  Mirrors Mesh's TRS surface (position/rotation/rotationQuaternion/scaling). */

import type { EngineContext } from "../engine/engine.js";
import type { RenderTargetSignature } from "../engine/render-target.js";
import type { DrawBinding, DrawUpdateContext, Renderable } from "../render/renderable.js";
import { ObservableVec3 } from "../math/observable-vec3.js";
import { ObservableQuat } from "../math/observable-quat.js";
import { composeTrsLocalMatrix, createWorldMatrixState } from "../scene/world-matrix-state.js";
import { createEulerProxy } from "../scene/scene-node.js";
import type { EulerProxy } from "../scene/scene-node.js";
import { createEmptyUniformBuffer } from "../resource/gpu-buffers.js";
import { addDeferredSceneRenderables } from "../scene/scene-core.js";
import type { SceneContext } from "../scene/scene-core.js";
import type { Mat4, Mat4Storage, Vec3 } from "../math/types.js";
import { mat4MultiplyInto } from "../math/mat4-multiply-into.js";
import { getViewProjectionMatrix, getEffectiveAspectRatio, _cameraChangeKey } from "../camera/camera.js";
import type { TextData } from "./text-data.js";
import { TEXT_INSTANCE_BYTES } from "./text-data.js";
import { ensureSharedAtlasGpu } from "./_gpu/text-textures.js";
import { createStyleBuffer, ensureStyleGpu } from "./_gpu/text-style-gpu.js";
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
    _device: GPUDevice;
    _textU: GPUBuffer;
    _instanceBuf: GPUBuffer;
    _instanceCap: number;
    _styleBuf: GPUBuffer;
    _uploadedStyleVersion: number;
    _pipeline: GPURenderPipeline;
    _uploadedDataVersion: number;
    _uploadedCameraVersion: number;
    _uploadedAspect: number;
    _uploadedViewportW: number;
    _uploadedViewportH: number;
    _uploadedOpacity: number;
    _targetKey: string;
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

    const wm = createWorldMatrixState(() => composeTrsLocalMatrix(r.position, r.rotationQuaternion, r.scaling));
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
    const { _pipeline: pipeline } = getOrCreateTextPipeline(engine, colorFormat, sampleCount, depthFormat, depthWrite, r);
    const key = targetSig(target);
    let gpu = r._gpu;
    if (gpu && gpu._device !== device) {
        gpu._textU.destroy();
        gpu._instanceBuf.destroy();
        gpu._styleBuf.destroy();
        gpu = null;
    }
    if (!gpu || gpu._targetKey !== key || gpu._pipeline !== pipeline) {
        if (!gpu) {
            const cap = Math.max(r._data._instanceCount, 8);
            gpu = {
                _device: device,
                _textU: createEmptyUniformBuffer(engine, TEXT_UBO_BYTES, "text-renderable-ubo"),
                _instanceBuf: device.createBuffer({
                    label: "text-instance",
                    size: cap * TEXT_INSTANCE_BYTES,
                    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
                }),
                _instanceCap: cap,
                _styleBuf: createStyleBuffer(device, 1),
                _uploadedStyleVersion: -1,
                _pipeline: pipeline,
                _uploadedDataVersion: -1,
                _uploadedCameraVersion: -1,
                _uploadedAspect: -1,
                _uploadedViewportW: 0,
                _uploadedViewportH: 0,
                _uploadedOpacity: NaN,
                _targetKey: key,
            };
            r._gpu = gpu;
        } else {
            gpu._pipeline = pipeline;
            gpu._targetKey = key;
            // Pipeline change — per-group bind groups must be rebuilt against the new bindGroupLayout.
            for (const g of r._data._groups) {
                g._bindGroup = null;
                g._bindGroupVersion = -1;
            }
        }
    }
    return gpu;
}

function ensureInstanceCapacity(device: GPUDevice, gpu: TextRenderableGpu, needed: number): void {
    if (needed <= gpu._instanceCap) {
        return;
    }
    let cap = gpu._instanceCap;
    while (cap < needed) {
        cap *= 2;
    }
    gpu._instanceBuf.destroy();
    gpu._instanceBuf = device.createBuffer({
        label: "text-instance",
        size: cap * TEXT_INSTANCE_BYTES,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    gpu._instanceCap = cap;
    gpu._uploadedDataVersion = -1;
}

function bindTextRenderable(r: TextRenderable, engine: EngineContext, target: RenderTargetSignature): DrawBinding {
    const gpu = ensureGpu(r, engine, target);
    const { _cache: cache } = getOrCreateTextPipeline(engine, target._colorFormat!, target._sampleCount === 1 ? 1 : 4, target._depthStencilFormat ?? null, !r.ignoreDepth, r);
    const quadVertex = cache._quadVertexBuffer;
    const bindGroupLayout = cache._bindGroupLayout;

    return {
        renderable: r,
        pipeline: gpu._pipeline,
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

    // Sync the style palette first: a grown buffer invalidates every group's bind group.
    const styleRecreated = ensureStyleGpu(device, data, gpu);

    // Sync every group's atlas to the GPU; track which need bind-group rebuild.
    for (const g of data._groups) {
        const { _rebuilt: rebuilt, _gpu: atlasGpu } = ensureSharedAtlasGpu(device, g._curveSet._atlas);
        if (rebuilt || styleRecreated || !g._bindGroup || g._bindGroupVersion !== atlasGpu._uploadedVersion) {
            g._bindGroup = device.createBindGroup({
                label: "text-bg0-" + g._curveSetId,
                layout: bindGroupLayout,
                entries: [
                    { binding: 0, resource: { buffer: gpu._textU } },
                    { binding: 1, resource: atlasGpu._curveTex.createView() },
                    { binding: 2, resource: atlasGpu._bandTex.createView() },
                    { binding: 3, resource: { buffer: atlasGpu._metaBuf } },
                    { binding: 4, resource: { buffer: gpu._styleBuf } },
                ],
            });
            g._bindGroupVersion = atlasGpu._uploadedVersion;
        }
    }

    // Sync instance buffer if data changed.
    ensureInstanceCapacity(device, gpu, data._instanceCount);
    if (gpu._uploadedDataVersion !== data._version) {
        if (data._instanceCount > 0) {
            // Partial upload when only a sub-range is dirty; full upload after grow/reset (when
            // _uploadedDataVersion is -1 we don't trust the dirty range).
            const dirtyValid = gpu._uploadedDataVersion !== -1 && data._dirtyEnd > data._dirtyStart;
            if (dirtyValid) {
                const startFloats = data._dirtyStart * (TEXT_INSTANCE_BYTES / 4);
                const endFloats = data._dirtyEnd * (TEXT_INSTANCE_BYTES / 4);
                const view = data._instances.subarray(startFloats, endFloats);
                device.queue.writeBuffer(gpu._instanceBuf, data._dirtyStart * TEXT_INSTANCE_BYTES, view.buffer as ArrayBuffer, view.byteOffset, view.byteLength);
            } else {
                const view = data._instances.subarray(0, data._instanceCount * (TEXT_INSTANCE_BYTES / 4));
                device.queue.writeBuffer(gpu._instanceBuf, 0, view.buffer as ArrayBuffer, view.byteOffset, view.byteLength);
            }
        }
        gpu._uploadedDataVersion = data._version;
        data._dirtyStart = 0;
        data._dirtyEnd = 0;
    }

    // Sync text UBO: mvp (vp * world) + viewport + color. The scene UBO is no longer
    // consumed by the text pipeline, so we compose the mvp here from the active camera.
    // Skip the recompute + upload when the world matrix, camera, and aspect are all unchanged.
    const camera = context._camera ?? null;
    if (camera) {
        const aspect = getEffectiveAspectRatio(camera, context.targetWidth, context.targetHeight);
        const camVer = _cameraChangeKey(camera);
        if (r._wmDirty || gpu._uploadedCameraVersion !== camVer || gpu._uploadedAspect !== aspect) {
            const vp = getViewProjectionMatrix(camera, aspect) as unknown as Float32Array;
            const wm = r._worldMatrix();
            mat4MultiplyInto(_mvpScratch, 0, vp, 0, wm as unknown as Mat4Storage, 0);
            device.queue.writeBuffer(gpu._textU, 0, _mvpScratch.buffer as ArrayBuffer, _mvpScratch.byteOffset, 64);
            r._wmDirty = false;
            gpu._uploadedCameraVersion = camVer;
            gpu._uploadedAspect = aspect;
        }
    }
    if (gpu._uploadedViewportW !== context.targetWidth || gpu._uploadedViewportH !== context.targetHeight) {
        const vp = new Float32Array([context.targetWidth, context.targetHeight, 0, 0]);
        device.queue.writeBuffer(gpu._textU, 64, vp.buffer as ArrayBuffer, vp.byteOffset, 16);
        gpu._uploadedViewportW = context.targetWidth;
        gpu._uploadedViewportH = context.targetHeight;
    }
    // Color uniform carries whole-block opacity as alpha (rgb fixed to white). Per-glyph color
    // comes from the instance `slugColor` attribute.
    if (gpu._uploadedOpacity !== r.opacity) {
        const col = new Float32Array([1, 1, 1, r.opacity]);
        device.queue.writeBuffer(gpu._textU, 80, col.buffer as ArrayBuffer, col.byteOffset, 16);
        gpu._uploadedOpacity = r.opacity;
    }
}

function drawTextRenderable(gpu: TextRenderableGpu, data: TextData, quadVertex: GPUBuffer, pass: GPURenderPassEncoder | GPURenderBundleEncoder): number {
    if (data._instanceCount === 0) {
        return 0;
    }
    pass.setVertexBuffer(0, quadVertex);
    pass.setVertexBuffer(1, gpu._instanceBuf);
    let draws = 0;
    for (const g of data._groups) {
        if (g._slotCount === 0 || !g._bindGroup) {
            continue;
        }
        pass.setBindGroup(0, g._bindGroup);
        pass.draw(6, g._slotCount, 0, g._slotStart);
        draws++;
    }
    return draws;
}

/** Release GPU buffers owned by a text renderable. The underlying `TextData` and `GlyphStorage` remain caller-owned. */
export function disposeTextRenderable(renderable: TextRenderable): void {
    if (renderable._gpu) {
        renderable._gpu._textU.destroy();
        renderable._gpu._instanceBuf.destroy();
        renderable._gpu._styleBuf.destroy();
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
