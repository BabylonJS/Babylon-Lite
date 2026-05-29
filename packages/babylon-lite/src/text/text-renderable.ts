/** TextRenderable — a scene-attachable text entity backed by a TextData.
 *  Mirrors Mesh's TRS surface (position/rotation/rotationQuaternion/scaling). */

import type { EngineContext, EngineContextInternal } from "../engine/engine.js";
import type { RenderTargetSignature } from "../engine/render-target.js";
import type { DrawBinding, DrawUpdateContext, Renderable } from "../render/renderable.js";
import { ObservableVec3 } from "../math/observable-vec3.js";
import { ObservableQuat } from "../math/observable-quat.js";
import { createWorldMatrixState } from "../scene/world-matrix-state.js";
import { createEulerProxy, eulerToQuat } from "../scene/scene-node.js";
import type { EulerProxy } from "../scene/scene-node.js";
import { mat4Compose } from "../math/mat4-compose.js";
import { mat4Identity } from "../math/mat4-identity.js";
import { createEmptyUniformBuffer } from "../resource/gpu-buffers.js";
import { addDeferredSceneRenderables } from "../scene/scene-core.js";
import type { SceneContext } from "../scene/scene-core.js";
import type { Vec3 } from "../math/types.js";
import type { TextData } from "./internal.js";
import type { TextDataInternals } from "./internal.js";
import { getTextDataInternalsOrThrow, TEXT_INSTANCE_BYTES } from "./text-data.js";
import { ensureSharedAtlasGpu } from "./_gpu/slug-textures.js";
import { getOrCreateTextPipeline } from "./_gpu/slug-pipeline.js";

export interface TextRenderableOptions {
    readonly position?: Readonly<Vec3>;
    readonly rotationQuaternion?: { readonly x: number; readonly y: number; readonly z: number; readonly w: number };
    readonly scaling?: Readonly<Vec3>;
    readonly color?: readonly [number, number, number, number];
    readonly ignoreDepth?: boolean;
    readonly order?: number;
}

export interface TextRenderable extends Renderable {
    readonly _entityType: "text";
    readonly position: ObservableVec3;
    readonly rotation: EulerProxy;
    readonly rotationQuaternion: ObservableQuat;
    readonly scaling: ObservableVec3;
    readonly color: [number, number, number, number];
    ignoreDepth: boolean;
    order: number;
    /** @internal */ readonly _data: TextData;
    /** @internal */ readonly _worldMatrix: () => Float32Array;
    /** @internal */ _wmDirty: boolean;
    /** @internal */ _gpu: TextRenderableGpu | null;
    /** @internal */ _version: number;
}

interface TextRenderableGpu {
    device: GPUDevice;
    textU: GPUBuffer;
    instanceBuf: GPUBuffer;
    instanceCap: number;
    bindGroup: GPUBindGroup | null;
    bindGroupVersion: number;
    pipeline: GPURenderPipeline;
    uploadedDataVersion: number;
    uploadedWorldVersion: number;
    uploadedViewportW: number;
    uploadedViewportH: number;
    uploadedColor: [number, number, number, number];
    targetKey: string;
}

const TEXT_UBO_BYTES = 64 /* world */ + 16 /* viewport */ + 16; /* color */

function targetSig(target: RenderTargetSignature): string {
    return (target.colorFormat ?? "-") + ":" + (target.sampleCount ?? 1) + ":" + (target.depthStencilFormat ?? "-") + ":" + (target.flipY ? "y" : "n");
}

export function createTextRenderable(data: TextData, options?: TextRenderableOptions): TextRenderable {
    const pos = options?.position;
    const rq = options?.rotationQuaternion;
    const sc = options?.scaling;
    const initRq = rq ?? { x: 0, y: 0, z: 0, w: 1 };
    void eulerToQuat;

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
        color: [options?.color?.[0] ?? 1, options?.color?.[1] ?? 1, options?.color?.[2] ?? 1, options?.color?.[3] ?? 1],
        ignoreDepth: options?.ignoreDepth ?? false,
        _data: data,
        _wmDirty: true,
        _gpu: null,
        _version: 0,
        _worldMatrix: () => wm.getWorldMatrix() as Float32Array,
        bind(engine, target): DrawBinding {
            return bindTextRenderable(r, engine, target);
        },
    };
    return r;
}

function ensureGpu(r: TextRenderable, engine: EngineContextInternal, target: RenderTargetSignature): TextRenderableGpu {
    const device = engine.device;
    const sampleCount = target.sampleCount === 1 ? 1 : 4;
    const colorFormat = target.colorFormat;
    if (!colorFormat) {
        throw new Error("TextRenderable: render target has no color format.");
    }
    const depthFormat = target.depthStencilFormat ?? null;
    const depthWrite = !r.ignoreDepth;
    const { pipeline } = getOrCreateTextPipeline(engine, colorFormat, sampleCount, depthFormat, depthWrite, target.flipY === true);
    const key = targetSig(target);
    let gpu = r._gpu;
    if (gpu && gpu.device !== device) {
        gpu.textU.destroy();
        gpu.instanceBuf.destroy();
        gpu = null;
    }
    if (!gpu || gpu.targetKey !== key || gpu.pipeline !== pipeline) {
        if (!gpu) {
            const internals = getTextDataInternalsOrThrow(r._data);
            const cap = Math.max(internals.instanceCount, 8);
            gpu = {
                device,
                textU: createEmptyUniformBuffer(engine, TEXT_UBO_BYTES, "text-renderable-ubo"),
                instanceBuf: device.createBuffer({
                    label: "text-instance",
                    size: cap * TEXT_INSTANCE_BYTES,
                    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
                }),
                instanceCap: cap,
                bindGroup: null,
                bindGroupVersion: -1,
                pipeline,
                uploadedDataVersion: -1,
                uploadedWorldVersion: -1,
                uploadedViewportW: 0,
                uploadedViewportH: 0,
                uploadedColor: [NaN, NaN, NaN, NaN],
                targetKey: key,
            };
            r._gpu = gpu;
        } else {
            gpu.pipeline = pipeline;
            gpu.targetKey = key;
            gpu.bindGroup = null;
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
    const eng = engine as EngineContextInternal;
    const gpu = ensureGpu(r, eng, target);
    const internals = getTextDataInternalsOrThrow(r._data);
    const { cache } = getOrCreateTextPipeline(eng, target.colorFormat!, target.sampleCount === 1 ? 1 : 4, target.depthStencilFormat ?? null, !r.ignoreDepth, target.flipY === true);
    const quadVertex = cache.quadVertexBuffer;
    const bgl1 = cache.bgl1;

    return {
        renderable: r,
        pipeline: gpu.pipeline,
        update(context: DrawUpdateContext): void {
            updateTextRenderable(r, eng, gpu, internals, bgl1, context);
        },
        draw(pass): number {
            return drawTextRenderable(gpu, internals, quadVertex, pass);
        },
    };
}

function updateTextRenderable(
    r: TextRenderable,
    engine: EngineContextInternal,
    gpu: TextRenderableGpu,
    internals: TextDataInternals,
    bgl1: GPUBindGroupLayout,
    context: DrawUpdateContext
): void {
    const device = engine.device;

    // Sync atlas to GPU; may recreate textures.
    const { rebuilt, gpu: atlasGpu } = ensureSharedAtlasGpu(device, internals.atlas);
    if (rebuilt) {
        gpu.bindGroup = null;
    }

    // Sync instance buffer if data changed.
    ensureInstanceCapacity(device, gpu, internals.instanceCount);
    if (gpu.uploadedDataVersion !== internals.version) {
        if (internals.instanceCount > 0) {
            const view = internals.instances.subarray(0, internals.instanceCount * (TEXT_INSTANCE_BYTES / 4));
            device.queue.writeBuffer(gpu.instanceBuf, 0, view.buffer as ArrayBuffer, view.byteOffset, view.byteLength);
        }
        gpu.uploadedDataVersion = internals.version;
    }

    // Sync text UBO: worldMatrix + viewport + color.
    const wmDirty = r._wmDirty;
    if (wmDirty) {
        const wm = r._worldMatrix();
        device.queue.writeBuffer(gpu.textU, 0, wm.buffer as ArrayBuffer, wm.byteOffset, 64);
        r._wmDirty = false;
        gpu.uploadedWorldVersion++;
    }
    if (gpu.uploadedViewportW !== context.targetWidth || gpu.uploadedViewportH !== context.targetHeight) {
        const vp = new Float32Array([context.targetWidth, context.targetHeight, 0, 0]);
        device.queue.writeBuffer(gpu.textU, 64, vp.buffer as ArrayBuffer, vp.byteOffset, 16);
        gpu.uploadedViewportW = context.targetWidth;
        gpu.uploadedViewportH = context.targetHeight;
    }
    const c = r.color;
    const uc = gpu.uploadedColor;
    if (uc[0] !== c[0] || uc[1] !== c[1] || uc[2] !== c[2] || uc[3] !== c[3]) {
        const col = new Float32Array(c);
        device.queue.writeBuffer(gpu.textU, 80, col.buffer as ArrayBuffer, col.byteOffset, 16);
        uc[0] = c[0];
        uc[1] = c[1];
        uc[2] = c[2];
        uc[3] = c[3];
    }

    if (!gpu.bindGroup || gpu.bindGroupVersion !== atlasGpu.uploadedVersion) {
        gpu.bindGroup = device.createBindGroup({
            label: "text-bg1",
            layout: bgl1,
            entries: [
                { binding: 0, resource: { buffer: gpu.textU } },
                { binding: 1, resource: atlasGpu.curveTex.createView() },
                { binding: 2, resource: atlasGpu.bandTex.createView() },
            ],
        });
        gpu.bindGroupVersion = atlasGpu.uploadedVersion;
    }
}

function drawTextRenderable(gpu: TextRenderableGpu, internals: TextDataInternals, quadVertex: GPUBuffer, pass: GPURenderPassEncoder | GPURenderBundleEncoder): number {
    if (internals.instanceCount === 0 || !gpu.bindGroup) {
        return 0;
    }
    pass.setBindGroup(1, gpu.bindGroup);
    pass.setVertexBuffer(0, quadVertex);
    pass.setVertexBuffer(1, gpu.instanceBuf);
    pass.draw(6, internals.instanceCount, 0, 0);
    return 1;
}

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
