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

import type { SceneNode } from "../scene/scene-node.js";
import type { EngineContextInternal } from "../engine/engine.js";
import type { Mat4 } from "../math/types.js";
import { mat4Identity, mat4Compose } from "../math/mat4.js";
import { ObservableVec3 } from "../math/observable-vec3.js";
import { ObservableQuat } from "../math/observable-quat.js";
import { createWorldMatrixState } from "../scene/world-matrix-state.js";
import { eulerToQuat, createEulerProxy } from "../scene/scene-node.js";
import { buildSplatGeometry, type SplatGeometry, type ParsedSplat } from "../loader-splat/splat-data.js";

/** Per-mesh GPU resources owned by a GaussianSplattingMesh. */
export interface GaussianSplattingGpu {
    centersTex: GPUTexture;
    centersView: GPUTextureView;
    covATex: GPUTexture;
    covAView: GPUTextureView;
    covBTex: GPUTexture;
    covBView: GPUTextureView;
    colorsTex: GPUTexture;
    colorsView: GPUTextureView;
    sampler: GPUSampler;
    /** Quad vertex buffer (4 vec2 corners). */
    quadBuffer: GPUBuffer;
    /** Quad index buffer (uint16 [0,1,2,0,2,3]). */
    indexBuffer: GPUBuffer;
    /** Per-instance splatIndex (Float32 × vertexCount), back-to-front order. */
    splatIndexBuffer: GPUBuffer;
    /** CPU-side scratch matching `splatIndexBuffer`. */
    splatIndexCpu: Float32Array;
    /** Packed view-dependent SH textures (1..5 rgba32uint), `null` when
     *  the cloud has no SH data. Layout: 16 bytes per splat per texture. */
    shTextures: GPUTexture[] | null;
    shViews: GPUTextureView[] | null;
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

    // ── Textures (RGBA32F, one texel per splat) ──────────────────────
    const makeRgba32f = (data: Float32Array): { tex: GPUTexture; view: GPUTextureView } => {
        const tex = device.createTexture({
            size: [geom.textureWidth, geom.textureHeight],
            format: "rgba32float",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        device.queue.writeTexture({ texture: tex }, data.buffer, { bytesPerRow: geom.textureWidth * 16 }, { width: geom.textureWidth, height: geom.textureHeight });
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
    const quadData = new Float32Array([-2, -2, 2, -2, 2, 2, -2, 2]);
    const quadBuffer = device.createBuffer({ size: quadData.byteLength, usage: GPUBufferUsage.VERTEX, mappedAtCreation: true });
    new Float32Array(quadBuffer.getMappedRange()).set(quadData);
    quadBuffer.unmap();

    const indexData = new Uint16Array([0, 1, 2, 0, 2, 3]);
    const indexBuffer = device.createBuffer({ size: 12, usage: GPUBufferUsage.INDEX, mappedAtCreation: true });
    new Uint16Array(indexBuffer.getMappedRange()).set(indexData);
    indexBuffer.unmap();

    // ── Instance buffer: identity splatIndex until the first sort lands. ──
    const splatIndexCpu = new Float32Array(geom.vertexCount);
    for (let i = 0; i < geom.vertexCount; i++) {
        splatIndexCpu[i] = i;
    }
    const splatIndexBuffer = device.createBuffer({
        size: splatIndexCpu.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(splatIndexBuffer, 0, splatIndexCpu.buffer, 0, splatIndexCpu.byteLength);

    // ── First-sort gate ──────────────────────────────────────────────
    let firstResolve: (() => void) | null = null;
    const firstSortReady = new Promise<void>((res) => {
        firstResolve = res;
    });

    // ── Retained source buffer (for splatsData + updateData) ─────────
    let retainedSplatsData = parsed.data;

    // ── Compose mesh ─────────────────────────────────────────────────
    // `shDegree` comes from the parser (0 means "no view-dependent SH").
    // The SH attacher (`gaussian-splatting-pipeline-sh.ts`, dynamic-imported
    // when `parsed.shDegree > 0`) creates the rgba32uint textures and
    // patches `mesh._gs.shTextures` in place. Keeping all SH-specific code
    // out of this module lets scenes that only need the static splat path
    // stay below their bundle ceilings.
    const mesh = {
        _kind: "gs-mesh",
        name,
        vertexCount: geom.vertexCount,
        textureWidth: geom.textureWidth,
        textureHeight: geom.textureHeight,
        boundMin: geom.boundMin.slice() as [number, number, number],
        boundMax: geom.boundMax.slice() as [number, number, number],
        shDegree: parsed.shDegree ?? 0,
        _worker: worker,
        _depthMix: new BigInt64Array(geom.vertexCount),
        _sortWorldMatrix: new Float32Array(16),
        _sortCameraForward: new Float32Array(3),
        _sortCameraPosition: new Float32Array(3),
        _canPostToWorker: true,
        firstSortReady,
        _firstSortResolve: firstResolve,
        _gs: {
            centersTex: centers.tex,
            centersView: centers.view,
            covATex: covA.tex,
            covAView: covA.view,
            covBTex: covB.tex,
            covBView: covB.view,
            colorsTex: colors.tex,
            colorsView: colors.view,
            sampler,
            quadBuffer,
            indexBuffer,
            splatIndexBuffer,
            splatIndexCpu,
            shTextures: null,
            shViews: null,
        },
    } as unknown as GaussianSplattingMesh;

    // splatsData getter — always returns the most-recently-loaded raw row buffer.
    Object.defineProperty(mesh, "splatsData", {
        get: () => retainedSplatsData,
        configurable: true,
        enumerable: false,
    });

    // updateData: replace splat data in place. Vertex count must match.
    (mesh as { updateData: (b: ArrayBuffer) => void }).updateData = (newBuffer: ArrayBuffer): void => {
        const newGeom = buildSplatGeometry(newBuffer);
        if (newGeom.vertexCount !== mesh.vertexCount) {
            throw new Error(`GaussianSplattingMesh.updateData: vertex count mismatch (got ${newGeom.vertexCount}, expected ${mesh.vertexCount})`);
        }
        const gs = mesh._gs;
        const writeTex = (tex: GPUTexture, data: Float32Array): void => {
            device.queue.writeTexture({ texture: tex }, data.buffer, { bytesPerRow: newGeom.textureWidth * 16 }, { width: newGeom.textureWidth, height: newGeom.textureHeight });
        };
        writeTex(gs.centersTex, newGeom.centersRGBA);
        writeTex(gs.covATex, newGeom.covARGBA);
        writeTex(gs.covBTex, newGeom.covBRGBA);
        writeTex(gs.colorsTex, newGeom.colorsRGBA);

        mesh.boundMin = newGeom.boundMin.slice() as [number, number, number];
        mesh.boundMax = newGeom.boundMax.slice() as [number, number, number];

        // Re-init the worker with the new positions buffer. The previous
        // positions array was transferred and is gone on this side, so we
        // hand the worker a fresh transferable. If a sort is currently in
        // flight, the message queues behind it and the worker swaps to the
        // new positions when it lands.
        mesh._worker.postMessage({ positions: newGeom.positions, vertexCount: newGeom.vertexCount }, [newGeom.positions.buffer]);
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
    worker.postMessage({ positions: geom.positions, vertexCount: geom.vertexCount }, [geom.positions.buffer]);

    worker.onmessage = (e: MessageEvent) => {
        const data = e.data as { depthMix: BigInt64Array };
        mesh._depthMix = data.depthMix;
        const indices = new Uint32Array(data.depthMix.buffer);
        const cpu = mesh._gs.splatIndexCpu;
        for (let j = 0; j < mesh.vertexCount; j++) {
            cpu[j] = indices[2 * j]!;
        }
        device.queue.writeBuffer(mesh._gs.splatIndexBuffer, 0, cpu.buffer, 0, cpu.byteLength);
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
    gs.centersTex.destroy();
    gs.covATex.destroy();
    gs.covBTex.destroy();
    gs.colorsTex.destroy();
    gs.quadBuffer.destroy();
    gs.indexBuffer.destroy();
    gs.splatIndexBuffer.destroy();
    if (gs.shTextures) {
        for (const tex of gs.shTextures) {
            tex.destroy();
        }
    }
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
}
