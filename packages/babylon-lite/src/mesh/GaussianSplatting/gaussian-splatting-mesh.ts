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

import type { SceneNode } from "../../scene/scene-node.js";
import type { EngineContextInternal } from "../../engine/engine.js";
import type { Mat4 } from "../../math/types.js";
import { mat4Identity, mat4Compose } from "../../math/mat4.js";
import { ObservableVec3 } from "../../math/observable-vec3.js";
import { ObservableQuat } from "../../math/observable-quat.js";
import { createWorldMatrixState, attachWorldMatrixState } from "../../scene/world-matrix-state.js";
import { eulerToQuat, createEulerProxy } from "../../scene/scene-node.js";
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
    _centersTex: GPUTexture;
    _centersView: GPUTextureView;
    _covATex: GPUTexture;
    _covAView: GPUTextureView;
    _covBTex: GPUTexture;
    _covBView: GPUTextureView;
    _colorsTex: GPUTexture;
    _colorsView: GPUTextureView;
    _sampler: GPUSampler;
    /** Quad vertex buffer (4 vec2 corners). */
    _quadBuffer: GPUBuffer;
    /** Quad index buffer (uint16 [0,1,2,0,2,3]). */
    _indexBuffer: GPUBuffer;
    /** Per-instance splatIndex (Float32 × vertexCount), back-to-front order. */
    _splatIndexBuffer: GPUBuffer;
    /** CPU-side scratch matching `splatIndexBuffer`. */
    _splatIndexCpu: Float32Array;
    /** Packed view-dependent SH textures (1..5 rgba32uint), `null` when
     *  the cloud has no SH data. Layout: 16 bytes per splat per texture. */
    _shTextures: GPUTexture[] | null;
    _shViews: GPUTextureView[] | null;
}

/** Public Gaussian-splatting mesh handle.  `_kind` is a brand so consumers can
 *  narrow on it; the renderable is wired up by `loadSplat()` directly. */
export interface GaussianSplattingMesh extends SceneNode {
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
    /** Sort worker. Owned by the mesh; terminated on dispose. */
    _worker: Worker;
    /** Scratch for the worker round-trip. high-32 = depth, low-32 = index. */
    _depthMix: BigInt64Array;
    /** Snapshot of the world matrix posted to the worker on the last sort.
     *  Used to decide whether a re-sort is needed this frame. Mirrors BJS
     *  `ICameraViewInfo.sortWorldMatrix`. */
    _sortWorldMatrix: Float32Array;
    /** Snapshot of the camera-forward vector (`view[2,6,10]`) on the last sort. */
    _sortCameraForward: Float32Array;
    /** Snapshot of the camera world-space position on the last sort. */
    _sortCameraPosition: Float32Array;
    /** True between postMessage and onmessage; throttles re-sort requests. */
    _canPostToWorker: boolean;
    /** Resolves on the first sort completion. The lab scene awaits this
     *  before flagging `dataset.ready`. */
    readonly firstSortReady: Promise<void>;
    _firstSortResolve: (() => void) | null;
    /** GPU resources, populated by `createGaussianSplattingMesh`. */
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
export function createGaussianSplattingMesh(engine: EngineContextInternal, name: string, geom: SplatGeometry, worker: Worker, parsed: ParsedSplat): GaussianSplattingMesh {
    const device = engine.device;
    const queue = device.queue;
    const { textureWidth, textureHeight, vertexCount } = geom;

    // ── Textures (RGBA32F, one texel per splat) ──────────────────────
    const makeRgba32f = (data: Float32Array): { tex: GPUTexture; view: GPUTextureView } => {
        const tex = device.createTexture({
            size: [textureWidth, textureHeight],
            format: "rgba32float",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
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
    const quadBuffer = device.createBuffer({ size: 32, usage: GPUBufferUsage.VERTEX, mappedAtCreation: true });
    new Float32Array(quadBuffer.getMappedRange()).set([-2, -2, 2, -2, 2, 2, -2, 2]);
    quadBuffer.unmap();

    const indexBuffer = device.createBuffer({ size: 12, usage: GPUBufferUsage.INDEX, mappedAtCreation: true });
    new Uint16Array(indexBuffer.getMappedRange()).set([0, 1, 2, 0, 2, 3]);
    indexBuffer.unmap();

    // ── Instance buffer: identity splatIndex until the first sort lands. ──
    const splatIndexCpu = new Float32Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) {
        splatIndexCpu[i] = i;
    }
    const splatIndexBuffer = device.createBuffer({
        size: splatIndexCpu.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
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
        _depthMix: new BigInt64Array(vertexCount),
        _sortWorldMatrix: new Float32Array(16),
        _sortCameraForward: new Float32Array(3),
        _sortCameraPosition: new Float32Array(3),
        _canPostToWorker: true,
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
        mesh._worker.postMessage({ p: newGeom.positions, n: newGeom.vertexCount }, [newGeom.positions.buffer]);
        // Force a re-sort on the next eligible frame by zeroing the snapshot
        // state — any real camera/world state will differ by more than the
        // gating threshold. (`_canPostToWorker` is left untouched — it's owned
        // by the worker protocol and toggling it here would risk double-posting
        // a `_depthMix` buffer that's still detached on the worker side.)
        mesh._sortWorldMatrix.fill(0);
        mesh._sortCameraForward.fill(0);
        mesh._sortCameraPosition.fill(0);

        retainedSplatsData = newBuffer;
    };

    initSplatTransform(mesh);

    // Ship the positions buffer to the worker once. After this `geom.positions`
    // is detached on this side — that's fine, we never need it again.
    worker.postMessage({ p: geom.positions, n: vertexCount }, [geom.positions.buffer]);

    worker.onmessage = (e: MessageEvent) => {
        const data = e.data as { d: BigInt64Array };
        mesh._depthMix = data.d;
        const indices = new Uint32Array(data.d.buffer);
        const cpu = mesh._gs._splatIndexCpu;
        for (let j = 0; j < mesh.vertexCount; j++) {
            cpu[j] = indices[2 * j]!;
        }
        queue.writeBuffer(mesh._gs._splatIndexBuffer, 0, cpu.buffer, 0, cpu.byteLength);
        mesh._canPostToWorker = true;
        if (mesh._firstSortResolve) {
            mesh._firstSortResolve();
            mesh._firstSortResolve = null;
        }
    };

    return mesh;
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
    const wm = createWorldMatrixState(() => {
        const p = node.position,
            rq = node.rotationQuaternion,
            s = node.scaling;
        const isIdentity = p.x === 0 && p.y === 0 && p.z === 0 && rq.x === 0 && rq.y === 0 && rq.z === 0 && rq.w === 1 && s.x === 1 && s.y === 1 && s.z === 1;
        return isIdentity ? mat4Identity() : mat4Compose(p.x, p.y, p.z, rq.x, rq.y, rq.z, rq.w, s.x, s.y, s.z);
    });
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
