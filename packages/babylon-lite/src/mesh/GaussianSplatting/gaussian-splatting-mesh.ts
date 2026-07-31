/** GaussianSplattingMesh — pure data describing a renderable Gaussian splat cloud.
 *
 *  Plain state with TRS + parent + children (`SceneNode`-shaped, no methods),
 *  plus splat-specific GPU resources and a worker handle for back-to-front sort.
 *  All behaviour lives in standalone functions in this file or in
 *  `gaussian-splatting-pipeline.ts`.
 *
 *  Renderable + dispose hook registration is performed by `loadSplat()` via
 *  `attachGaussianSplattingMesh()` — scene-core stays GS-agnostic so non-GS
 *  scenes never pull in this pipeline. */

import { F32, U32, U16 } from "../../engine/typed-arrays.js";
import { TU, BU } from "../../engine/gpu-flags.js";
import type { SceneNode } from "../../scene/scene-node.js";
import type { EngineContext } from "../../engine/engine.js";
import type { Mat4 } from "../../math/types.js";
import { ObservableVec3 } from "../../math/observable-vec3.js";
import { ObservableQuat } from "../../math/observable-quat.js";
import { createWorldMatrixState, attachWorldMatrixState, composeTrsLocalMatrix } from "../../scene/world-matrix-state.js";
import { createEulerProxy } from "../../scene/scene-node.js";
import { eulerToQuat } from "../../math/quat-euler.js";
import { buildSplatGeometry, type SplatGeometry, type ParsedSplat } from "../../loader-splat/splat-data.js";

/** Names of the four WGSL slots a `GsShaderFragment` may inject into the
 *  Gaussian-splat fragment shader. Markers in the WGSL source look like
 *  `\/*GS_FRAGMENT_MAIN_END*\/` — valid comments when no plugin is present. */
export type GsFragmentSlot = "GS_FRAGMENT_DEFINITIONS" | "GS_FRAGMENT_MAIN_BEGIN" | "GS_FRAGMENT_BEFORE_FRAGCOLOR" | "GS_FRAGMENT_MAIN_END";

/** Data-only descriptor of a GS shader plugin. Lite equivalent of a BJS
 *  `MaterialPluginBase`: snippets get spliced into the four GS fragment slots. */
export interface GsShaderFragment {
    readonly id: string;
    readonly fragmentSlots?: Partial<Record<GsFragmentSlot, string>>;
    readonly helperFunctions?: string;
}

/** Per-mesh GPU resources owned by a GaussianSplattingMesh. */
export interface GaussianSplattingGpu {
    /** @internal */
    _centersTex: GPUTexture;
    /** @internal */
    _centersView: GPUTextureView;
    /** @internal */
    _covATex: GPUTexture;
    /** @internal */
    _covAView: GPUTextureView;
    /** @internal */
    _covBTex: GPUTexture;
    /** @internal */
    _covBView: GPUTextureView;
    /** @internal */
    _colorsTex: GPUTexture;
    /** @internal */
    _colorsView: GPUTextureView;
    /** @internal */
    _sampler: GPUSampler;
    /** @internal Quad vertex buffer (4 vec2 corners). */
    _quadBuffer: GPUBuffer;
    /** @internal Quad index buffer (uint16 [0,1,2,0,2,3]). */
    _indexBuffer: GPUBuffer;
    /** @internal Per-instance splatIndex (Float32 × vertexCount), back-to-front order. */
    _splatIndexBuffer: GPUBuffer;
    /** @internal CPU-side scratch matching `splatIndexBuffer`. */
    _splatIndexCpu: Float32Array;
    /** Packed view-dependent SH textures (1..5 rgba32uint), `null` when
     *  the cloud has no SH data. Layout: 16 bytes per splat per texture. */
    /** @internal */
    _shTextures: GPUTexture[] | null;
    /** @internal */
    _shViews: GPUTextureView[] | null;
}

/** Public Gaussian-splatting mesh handle.  `_kind` is a brand so consumers can
 *  narrow on it; the renderable is wired up by `loadSplat()` directly. */
export interface GaussianSplattingMesh extends SceneNode {
    /** @internal */
    readonly _kind: "gs-mesh";
    /** Number of splats in the cloud. */
    readonly vertexCount: number;
    /** RGBA32F texture dimensions used for centers/covA/covB/colors. */
    readonly textureWidth: number;
    readonly textureHeight: number;
    /** World-space AABB across all splat centres (for camera framing). */
    boundMin: [number, number, number];
    boundMax: [number, number, number];
    /** Spherical-harmonics degree (0 means no view-dependent SH). Set at load
     *  time and immutable afterwards — `updateData` rejects a degree change. */
    readonly shDegree: number;
    /** @internal Sort worker. Owned by the mesh; terminated on dispose. */
    _worker: Worker;
    /** @internal Free transferable order buffers ready to post to the sort
     *  worker. Starts with two (double-buffered): a second sort job can be
     *  posted while the previous result is still in transit, so the worker
     *  never idles on the round-trip during continuous camera motion. Empty
     *  means two sorts are already in flight. */
    _orderPool: Uint32Array[];
    /** @internal Latest sorted order received from the worker, awaiting GPU
     *  upload. Consumed by `uploadPendingSplatOrder` on the next frame — at
     *  most one upload per frame, and if a newer result lands before the
     *  upload happens the stale one is dropped back into the pool unused. */
    _pendingOrder: Uint32Array | null;
    /** @internal Snapshot of the affine view-depth transform `(a,b,c,d)` sent
     *  on the last sort. A re-sort is needed only when these coefficients
     *  change, regardless of which camera/world component caused the change. */
    _sortDepthTransform: Float32Array;
    /** @internal Scratch for the current affine view-depth transform. */
    _nextSortDepthTransform: Float32Array;
    /** Resolves on the first sort completion. The lab scene awaits this
     *  before flagging `dataset.ready`. */
    readonly firstSortReady: Promise<void>;
    /** @internal Resolver for {@link firstSortReady}; called once the first sort completes, then cleared to null. */
    _firstSortResolve: (() => void) | null;
    /** @internal GPU resources, populated by `createGaussianSplattingMesh`. */
    _gs: GaussianSplattingGpu;
    /** Raw 32-byte/splat row buffer. Mirrors BJS `splatsData` (with
     *  `keepInRam:true`) — exposed for inspection + `updateData` round-trips. */
    readonly splatsData: ArrayBuffer;
    /** Replace the splat data in place. Re-uploads centres / covariance /
     *  colour textures, re-posts positions to the sort worker, and updates the
     *  AABB. Vertex count must match the original buffer. Mirrors BJS
     *  `GaussianSplattingMesh.updateData(buffer, _sh, opts)`. */
    updateData(splatBuffer: ArrayBuffer): void;
}

/** Create a GaussianSplattingMesh from a parsed splat asset. Uploads textures +
 *  initial identity splat-index buffer, spawns the sort worker, and (when the
 *  asset includes SH coefficients) packs SH into rgba32uint textures.
 *
 *  `parsed.data` is retained on the mesh as `splatsData` so callers can mutate
 *  the row data and round-trip it via `mesh.updateData(buffer)` — matches
 *  `keepInRam:true` semantics on BJS `GaussianSplattingMesh`. */
export function createGaussianSplattingMesh(engine: EngineContext, name: string, geom: SplatGeometry, worker: Worker, parsed: ParsedSplat): GaussianSplattingMesh {
    const device = engine._device;
    const queue = device.queue;
    const { textureWidth, textureHeight, vertexCount } = geom;

    // ── Textures (RGBA32F, one texel per splat) ──────────────────────
    const makeRgba32f = (data: Float32Array): { tex: GPUTexture; view: GPUTextureView } => {
        const tex = device.createTexture({
            size: [textureWidth, textureHeight],
            format: "rgba32float",
            usage: TU.TEXTURE_BINDING | TU.COPY_DST,
        });
        queue.writeTexture({ texture: tex }, data.buffer, { bytesPerRow: textureWidth * 16 }, { width: textureWidth, height: textureHeight });
        return { tex, view: tex.createView() };
    };
    const centers = makeRgba32f(geom.centersRGBA);
    const covA = makeRgba32f(geom.covARGBA);
    const covB = makeRgba32f(geom.covBRGBA);
    const colors = makeRgba32f(geom.colorsRGBA);

    const sampler = device.createSampler({
        magFilter: "nearest",
        minFilter: "nearest",
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
    });

    // ── Quad geometry (shared by all instances) ──────────────────────
    const quadBuffer = device.createBuffer({ size: 32, usage: BU.VERTEX, mappedAtCreation: true });
    new F32(quadBuffer.getMappedRange()).set([-2, -2, 2, -2, 2, 2, -2, 2]);
    quadBuffer.unmap();

    const indexBuffer = device.createBuffer({ size: 12, usage: BU.INDEX, mappedAtCreation: true });
    new U16(indexBuffer.getMappedRange()).set([0, 1, 2, 0, 2, 3]);
    indexBuffer.unmap();

    // ── Instance buffer: identity splatIndex until the first sort lands. ──
    const splatIndexCpu = new F32(vertexCount);
    for (let i = 0; i < vertexCount; i++) {
        splatIndexCpu[i] = i;
    }
    const splatIndexBuffer = device.createBuffer({
        size: splatIndexCpu.byteLength,
        usage: BU.VERTEX | BU.COPY_DST,
    });
    queue.writeBuffer(splatIndexBuffer, 0, splatIndexCpu.buffer, 0, splatIndexCpu.byteLength);

    // ── First-sort gate ──────────────────────────────────────────────
    let firstResolve: (() => void) | null = null;
    const firstSortReady = new Promise<void>((res) => {
        firstResolve = res;
    });

    // ── Retained source buffer (for splatsData + updateData) ─────────
    let retainedSplatsData = parsed.data;

    // ── Compose mesh ─────────────────────────────────────────────────
    // `shDegree` comes from the parser (0 means "no view-dependent SH").
    // The SH attacher is dynamic-imported when needed and patches `_gs` in place,
    // keeping SH-specific code out of static splat scenes.
    const mesh = {
        _kind: "gs-mesh",
        name,
        vertexCount,
        textureWidth,
        textureHeight,
        boundMin: geom.boundMin.slice() as [number, number, number],
        boundMax: geom.boundMax.slice() as [number, number, number],
        shDegree: parsed.shDegree ?? 0,
        _worker: worker,
        _orderPool: [new U32(vertexCount), new U32(vertexCount)],
        _pendingOrder: null,
        _sortDepthTransform: new F32(4),
        _nextSortDepthTransform: new F32(4),
        firstSortReady,
        _firstSortResolve: firstResolve,
        _gs: {
            _centersTex: centers.tex,
            _centersView: centers.view,
            _covATex: covA.tex,
            _covAView: covA.view,
            _covBTex: covB.tex,
            _covBView: covB.view,
            _colorsTex: colors.tex,
            _colorsView: colors.view,
            _sampler: sampler,
            _quadBuffer: quadBuffer,
            _indexBuffer: indexBuffer,
            _splatIndexBuffer: splatIndexBuffer,
            _splatIndexCpu: splatIndexCpu,
            _shTextures: null,
            _shViews: null,
        },
    } as unknown as GaussianSplattingMesh;

    // splatsData getter — always returns the most-recently-loaded raw row buffer.
    Object.defineProperty(mesh, "splatsData", {
        get: () => retainedSplatsData,
    });

    // updateData: replace splat data in place. Vertex count must match.
    (mesh as { updateData: (b: ArrayBuffer) => void }).updateData = (newBuffer: ArrayBuffer): void => {
        const newGeom = buildSplatGeometry(newBuffer);
        if (newGeom.vertexCount !== mesh.vertexCount) {
            throw Error("GS vertex count mismatch");
        }
        const gs = mesh._gs;
        const writeTex = (tex: GPUTexture, data: Float32Array): void => {
            queue.writeTexture({ texture: tex }, data.buffer, { bytesPerRow: newGeom.textureWidth * 16 }, { width: newGeom.textureWidth, height: newGeom.textureHeight });
        };
        writeTex(gs._centersTex, newGeom.centersRGBA);
        writeTex(gs._covATex, newGeom.covARGBA);
        writeTex(gs._covBTex, newGeom.covBRGBA);
        writeTex(gs._colorsTex, newGeom.colorsRGBA);

        mesh.boundMin = newGeom.boundMin.slice() as [number, number, number];
        mesh.boundMax = newGeom.boundMax.slice() as [number, number, number];

        // Re-init the worker with the new positions buffer. The previous
        // positions array was transferred and is gone on this side, so we
        // hand the worker a fresh transferable. If a sort is currently in
        // flight, the message queues behind it and the worker swaps to the
        // new positions when it lands.
        mesh._worker.postMessage({ p: newGeom.positions }, [newGeom.positions.buffer]);
        // Force a re-sort on the next eligible frame by zeroing the snapshot
        // state — any real camera/world state will differ by more than the
        // gating threshold. (`_orderPool` is left untouched — in-flight sort
        // jobs queued behind the init message still return their buffers via
        // `onmessage`; their ordering may briefly be stale for the new data,
        // which the forced re-sort corrects.)
        mesh._sortDepthTransform.fill(0);

        retainedSplatsData = newBuffer;
    };

    initSplatTransform(mesh);

    // Ship the positions buffer to the worker once. After this `geom.positions`
    // is detached on this side — that's fine, we never need it again.
    worker.postMessage({ p: geom.positions }, [geom.positions.buffer]);

    worker.onmessage = (e: MessageEvent) => {
        const data = e.data as { o: Uint32Array };
        // Latest wins: if an older result is still awaiting upload, drop it
        // straight back into the pool — only the newest ordering reaches the GPU.
        if (mesh._pendingOrder) {
            mesh._orderPool.push(mesh._pendingOrder);
        }
        mesh._pendingOrder = data.o;
        if (mesh._firstSortResolve) {
            mesh._firstSortResolve();
            mesh._firstSortResolve = null;
        }
    };

    return mesh;
}

/** Per-element threshold on the world matrix / camera forward / camera
 *  position drift below which a re-sort is skipped. Mirrors BJS
 *  `viewUpdateThreshold` default (`_DefaultViewUpdateThreshold = 1e-4`). */
const SORT_EPS = 1e-4;

/** Upload the latest sorted splat order (if one arrived since the last frame)
 *  into the instance buffer, then recycle its transferable back into the pool.
 *  Called once per frame from the renderable's `update` hook — results the
 *  worker produced faster than the frame rate never cost an upload. */
export function uploadPendingSplatOrder(queue: GPUQueue, mesh: GaussianSplattingMesh): void {
    const order = mesh._pendingOrder;
    if (!order) {
        return;
    }
    mesh._pendingOrder = null;
    const cpu = mesh._gs._splatIndexCpu;
    cpu.set(order);
    queue.writeBuffer(mesh._gs._splatIndexBuffer, 0, cpu.buffer, 0, cpu.byteLength);
    mesh._orderPool.push(order);
}

/** Post a sort job when a buffer is free and the affine view-depth transform
 *  drifted past `SORT_EPS` since the last posted sort. The four coefficients
 *  are row 2 of `view * world`, computed directly from the two matrices. */
export function postSplatSortIfDirty(mesh: GaussianSplattingMesh, world: Float32Array, view: Float32Array): void {
    if (mesh._orderPool.length === 0) {
        return;
    }

    const v0 = view[2]!;
    const v1 = view[6]!;
    const v2 = view[10]!;
    const last = mesh._sortDepthTransform;
    const next = mesh._nextSortDepthTransform;
    let dirty = false;
    for (let i = 0; i < 4; i++) {
        next[i] = v0 * world[4 * i]! + v1 * world[4 * i + 1]! + v2 * world[4 * i + 2]! + (i === 3 ? view[14]! : 0);
        if (Math.abs(last[i]! - next[i]!) > SORT_EPS) {
            dirty = true;
        }
    }
    if (!dirty) {
        return;
    }

    last.set(next);
    const order = mesh._orderPool.pop()!;
    mesh._worker.postMessage({ t: last, o: order }, [order.buffer]);
}

/** Free all GPU + worker resources owned by a GS mesh. */
export function disposeGaussianSplattingMesh(mesh: GaussianSplattingMesh): void {
    const gs = mesh._gs;
    [gs._centersTex, gs._covATex, gs._covBTex, gs._colorsTex, gs._quadBuffer, gs._indexBuffer, gs._splatIndexBuffer, ...(gs._shTextures ?? [])].forEach((resource) =>
        resource.destroy()
    );
    mesh._worker.terminate();
}

// Same TRS + worldMatrix wiring as `initMeshTransform` in mesh/mesh.ts but
// duplicated here to avoid pulling the Mesh module into the GS code path.
function initSplatTransform(node: GaussianSplattingMesh): void {
    const wm = createWorldMatrixState(() => composeTrsLocalMatrix(node.position, node.rotationQuaternion, node.scaling));
    const onDirty = (): void => wm.markLocalDirty();
    const [iqx, iqy, iqz, iqw] = eulerToQuat(0, 0, 0);
    const rq = new ObservableQuat(iqx, iqy, iqz, iqw, onDirty);
    (node as unknown as Record<string, unknown>).rotationQuaternion = rq;
    (node as unknown as Record<string, unknown>).rotation = createEulerProxy(rq);
    (node as unknown as Record<string, unknown>).position = new ObservableVec3(0, 0, 0, onDirty);
    (node as unknown as Record<string, unknown>).scaling = new ObservableVec3(1, 1, 1, onDirty);
    (node as unknown as Record<string, unknown>).children = [];

    Object.defineProperty(node, "parent", {
        get() {
            return wm.parent;
        },
        set(v) {
            wm.parent = v;
        },
        configurable: true,
        enumerable: true,
    });
    Object.defineProperty(node, "worldMatrix", {
        get(): Mat4 {
            return wm.getWorldMatrix();
        },
        configurable: true,
        enumerable: false,
    });
    Object.defineProperty(node, "worldMatrixVersion", {
        get(): number {
            return wm.getWorldMatrixVersion();
        },
        configurable: true,
        enumerable: false,
    });
    // Tag so children parented to this splat mesh get push invalidation.
    attachWorldMatrixState(node, wm);
}
