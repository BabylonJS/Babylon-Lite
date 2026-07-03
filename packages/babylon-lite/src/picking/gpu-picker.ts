import { F32, U32, U8 } from "../engine/typed-arrays.js";
import { TU, BU } from "../engine/gpu-flags.js";
import type { SceneContext } from "../scene/scene.js";
import type { Mesh } from "../mesh/mesh.js";
import type { PickingInfo } from "./picking-info.js";
import type { EngineContext } from "../engine/engine.js";
import type * as DeformedGeometry from "./deformed-geometry.js";
import type * as GsPickingPipeline from "./gs-picking-pipeline.js";
import type { GaussianSplattingMesh } from "../mesh/GaussianSplatting/gaussian-splatting-mesh.js";
import { createEmptyPickingInfo } from "./picking-info.js";
import { createPickingRay } from "./ray.js";
import { mat4Invert } from "../math/mat4-invert.js";
import { getPickingPipelineSet, getPickingSceneBGL } from "./picking-pipeline.js";
import { getViewProjectionMatrix, getCameraPosition } from "../camera/camera.js";
import { resolveCameraViewport } from "../camera/viewport.js";
import { createEmptyUniformBuffer, createMappedBuffer, createUniformBuffer } from "../resource/gpu-buffers.js";

// ─── Scratch arrays — allocated once, reused across all picks ──────
const _pickVP = new F32(16);
const _gsPickMatrix = new F32(16);
const PICK_MESH_UBO_BYTES = 80;
const PICK_TI_UBO_BYTES = 16;
const _uboScratch = new ArrayBuffer(PICK_MESH_UBO_BYTES);
const _uboF32 = new F32(_uboScratch);
const _uboU32 = new U32(_uboScratch);
const _uboView = new U8(_uboScratch);
const _tiUboScratch = new ArrayBuffer(PICK_TI_UBO_BYTES);
const _tiUboU32 = new U32(_tiUboScratch);
const _tiUboView = new U8(_tiUboScratch);

/** GPU-based picker — pure state. Use pickAsync() and disposePicker() standalone functions. */
export interface GpuPicker {
    /** @internal Optional hook for detailed picking (Phase 2). */
    _detailedPick: ((info: PickingInfo, ray: { origin: [number, number, number]; direction: [number, number, number]; length: number }) => void | Promise<void>) | null;
    /** @internal */
    _scene: SceneContext;
    /** @internal 1×1 render targets (lazily created). */
    _rt: PickTargets1x1 | null;
    /** @internal Reusable scene UBO (64 bytes). */
    _sceneUbo: GPUBuffer | null;
    /** @internal Reusable scene bind group. */
    _sceneBG: GPUBindGroup | null;
    /** @internal Per-GS-mesh picking resources (created on demand). */
    _gsMeshResources: Map<GaussianSplattingMesh, GsPickingPipeline.GsPickMeshResources> | null;
    /** @internal Tail of the serialized pick queue for this picker — see pickAsync(). */
    _pending: Promise<void> | null;
}

interface PickTargets1x1 {
    colorTex: GPUTexture;
    colorView: GPUTextureView;
    depthColorTex: GPUTexture;
    depthColorView: GPUTextureView;
    depthTex: GPUTexture;
    depthView: GPUTextureView;
    colorStaging: GPUBuffer;
    depthStaging: GPUBuffer;
}

/** Create a GPU picker bound to the given scene. */
export function createGpuPicker(scene: SceneContext): GpuPicker {
    return {
        _detailedPick: null,
        _scene: scene,
        _rt: null,
        _sceneUbo: null,
        _sceneBG: null,
        _gsMeshResources: null,
        _pending: null,
    };
}

function ensureTargets(engine: EngineContext, picker: GpuPicker): PickTargets1x1 {
    const device = engine._device;
    if (picker._rt) {
        return picker._rt;
    }
    const colorTex = device.createTexture({ label: "pick-color", size: [1, 1], format: "rgba8unorm", usage: TU.RENDER_ATTACHMENT | TU.COPY_SRC });
    const depthColorTex = device.createTexture({
        label: "pick-depth-color",
        size: [1, 1],
        format: "r32float",
        usage: TU.RENDER_ATTACHMENT | TU.COPY_SRC,
    });
    const depthTex = device.createTexture({ label: "pick-depth", size: [1, 1], format: "depth24plus", usage: TU.RENDER_ATTACHMENT });
    picker._rt = {
        colorTex,
        colorView: colorTex.createView(),
        depthColorTex,
        depthColorView: depthColorTex.createView(),
        depthTex,
        depthView: depthTex.createView(),
        colorStaging: device.createBuffer({ label: "pick-color-staging", size: 256, usage: BU.COPY_DST | BU.MAP_READ }),
        depthStaging: device.createBuffer({ label: "pick-depth-staging", size: 256, usage: BU.COPY_DST | BU.MAP_READ }),
    };
    return picker._rt;
}

function ensureSceneUbo(engine: EngineContext, picker: GpuPicker): GPUBuffer {
    const device = engine._device;
    if (!picker._sceneUbo) {
        picker._sceneUbo = createEmptyUniformBuffer(engine, 64, "pick-scene-ubo");
        const sceneBGL = getPickingSceneBGL(engine);
        picker._sceneBG = device.createBindGroup({ label: "pick-scene-bg", layout: sceneBGL, entries: [{ binding: 0, resource: { buffer: picker._sceneUbo } }] });
    }
    return picker._sceneUbo;
}

/** Compute a VP matrix zoomed to a single pixel at (px, py) on a W×H canvas.
 *  Renders to a 1×1 target — only fragments at the picked pixel survive. */
function computePickVP(out: Float32Array, vp: Float32Array, px: number, py: number, w: number, h: number): void {
    const ndcX = (2 * (px + 0.5)) / w - 1;
    const ndcY = 1 - (2 * (py + 0.5)) / h;
    // pickVP = pickMatrix * VP (sparse multiply, see derivation in comments)
    for (let c = 0; c < 4; c++) {
        const base = c * 4;
        const w3 = vp[base + 3]!;
        out[base] = w * (vp[base]! - ndcX * w3);
        out[base + 1] = h * (vp[base + 1]! - ndcY * w3);
        out[base + 2] = vp[base + 2]!;
        out[base + 3] = w3;
    }
}

/** Options for {@link pickAsync}. */
export interface PickOptions {
    /** Restrict the pick to a subset of the scene's meshes — return `true` for a mesh that may be picked,
     *  `false` to ignore it entirely (it neither occludes nor is returned). Lets a caller provide its
     *  "list of pickables" so decorative meshes (grass, foliage, particles, …) can't swallow a pick of a
     *  structure behind/around them. When omitted, every mesh is pickable (previous behaviour). Applied
     *  identically to the id-assignment and id-resolve passes so ids stay consistent. */
    filter?: (mesh: Mesh) => boolean;
    /** Optional GPU fragment-discard extension for app-specific pick removal.
     *
     *  `wgsl` is injected into the regular and thin-instance picking shaders and must define:
     *
     *  `fn shouldDiscardPick(input: PickDiscardInput) -> bool`
     *
     *  The input exposes only generic picker data: `worldPos`, `pickId`, `thinInstanceIndex`,
     *  `hasThinInstance`, and `instanceExtras` (the original thin-instance matrix w lanes, zero for
     *  non-instanced meshes). Storage entries are uploaded and bound by Lite for the current pick only. */
    discard?: PickDiscardRule;
    /** Dev-only diagnostics: logs the pick ray, pixel, pick id/depth and resolved mesh. */
    debugLabel?: string;
}

/**
 * Optional GPU-side discard rule for {@link pickAsync}.
 *
 * This lets apps remove pick hits with custom WGSL while keeping the main scene
 * render untouched. The WGSL must define
 * `fn shouldDiscardPick(input: PickDiscardInput) -> bool`.
 */
export interface PickDiscardRule {
    /** Stable cache key for the generated picking pipeline set. Change it when the WGSL or layout changes. */
    readonly key: string;
    /** WGSL source that defines `shouldDiscardPick(input: PickDiscardInput) -> bool`. */
    readonly wgsl: string;
    /** Optional typed-array storage inputs exposed to the discard WGSL at group 2. */
    readonly storage?: readonly PickDiscardStorage[];
}

/** Storage data for a pick discard rule. Lite injects the WGSL declaration and owns the GPU buffer upload. */
export interface PickDiscardStorage {
    /** WGSL variable name declared at `@group(2) @binding(index)`; must be unique within the rule. */
    readonly name: string;
    /** WGSL storage type, for example `array<vec4<f32>>`. */
    readonly type: string;
    /** Per-mesh data for the current pick. Return `null` to draw that mesh with the default picker. */
    readonly data: (mesh: Mesh) => ArrayBufferView | null | undefined;
}

function createPickDiscardBindGroup(engine: EngineContext, layout: GPUBindGroupLayout, discard: PickDiscardRule, mesh: Mesh, tempBuffers: GPUBuffer[]): GPUBindGroup | null {
    const storage = discard.storage;
    if (!storage || storage.length === 0) {
        return null;
    }
    const entries: GPUBindGroupEntry[] = [];
    for (let i = 0; i < storage.length; i++) {
        const data = storage[i]!.data(mesh);
        if (!data) {
            return null;
        }
        const buffer = createMappedBuffer(engine, data, BU.STORAGE);
        tempBuffers.push(buffer);
        entries.push({ binding: i, resource: { buffer } });
    }
    const device = engine._device;
    return device.createBindGroup({
        label: `pick-discard-${discard.key}-bg`,
        layout,
        entries,
    });
}

/** Pick the mesh at CSS-space canvas coordinates, matching Babylon.js Scene.pick. Returns a PickingInfo.
 *  Does the actual GPU render + readback for one pick — call `pickAsync` (below) instead; it serializes
 *  concurrent calls on the same picker so their shared 1×1 staging buffers never race. */
async function pickAsyncImpl(picker: GpuPicker, x: number, y: number, options?: PickOptions): Promise<PickingInfo> {
    const scene = picker._scene;
    const pickFilter = options?.filter ?? null;
    const pickDiscard = options?.discard ?? null;
    const debugLabel = options?.debugLabel;
    const engine = scene.surface.engine;
    const device = engine._device;
    // Pick coordinates are relative to the scene's own surface canvas, not the engine's
    // primary canvas — they differ when the scene renders into an auxiliary surface.
    const canvas = scene.surface.canvas;
    const camera = scene.camera;
    if (!camera) {
        return createEmptyPickingInfo();
    }

    const backingWidth = canvas.width;
    const backingHeight = canvas.height;
    const clientWidth = ("clientWidth" in canvas ? canvas.clientWidth : 0) || backingWidth;
    const clientHeight = ("clientHeight" in canvas ? canvas.clientHeight : 0) || backingHeight;
    const scaleX = backingWidth / clientWidth;
    const scaleY = backingHeight / clientHeight;
    const pickX = x * scaleX;
    const pickY = y * scaleY;
    const viewport = resolveCameraViewport(camera, backingWidth, backingHeight);
    const w = viewport.width;
    const h = viewport.height;
    if (w === 0 || h === 0) {
        return createEmptyPickingInfo();
    }

    if (pickX < viewport.x || pickY < viewport.y || pickX >= viewport.x + viewport.width || pickY >= viewport.y + viewport.height) {
        return createEmptyPickingInfo();
    }

    const px = Math.max(0, Math.min(Math.floor(pickX - viewport.x), w - 1));
    const py = Math.max(0, Math.min(Math.floor(pickY - viewport.y), h - 1));
    const aspect = w / h;
    const vp = getViewProjectionMatrix(camera, aspect);
    const debugRay = debugLabel ? createPickingRay(px, py, vp, w, h) : null;

    // ── Compute pick-zoomed VP (renders single pixel to 1×1 target) ──
    computePickVP(_pickVP, vp as unknown as Float32Array, px, py, w, h);

    const rt = ensureTargets(engine, picker);
    const sceneUbo = ensureSceneUbo(engine, picker);
    device.queue.writeBuffer(sceneUbo, 0, _pickVP);

    // ── Assign pick IDs (array-based, no Map for miss case) ──────────
    const meshes = scene.meshes;
    const meshCount = meshes.length;
    let nextId = 1;
    let deformedGeometry: typeof DeformedGeometry | null = null;
    for (let mi = 0; mi < meshCount; mi++) {
        const mesh = meshes[mi]!;
        if ((mesh.morphTargets || mesh.skeleton) && mesh._cpuPositions) {
            deformedGeometry = await import("./deformed-geometry.js");
            break;
        }
    }

    // ── Render pass (1×1 target) ─────────────────────────────────────
    const encoder = device.createCommandEncoder({ label: "pick" });
    const pass = encoder.beginRenderPass({
        colorAttachments: [
            { view: rt.colorView, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "store" },
            { view: rt.depthColorView, clearValue: { r: 1, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "store" },
        ],
        depthStencilAttachment: { view: rt.depthView, depthClearValue: 0, depthLoadOp: "clear", depthStoreOp: "discard" },
    });

    const defaultPipelines = getPickingPipelineSet(engine);
    const discardPipelines = pickDiscard ? getPickingPipelineSet(engine, pickDiscard) : null;

    const tempBuffers: GPUBuffer[] = [];
    for (let mi = 0; mi < meshCount; mi++) {
        const mesh = meshes[mi]!;
        // Skip meshes explicitly marked non-pickable.  Mirrors BJS
        // `isPickable = false` — lets gizmos toggle display-only helpers
        // (e.g. the rotation-sector display plane) out of the picker without
        // affecting their rendering or hiding them from picks via `visible`.
        if (mesh.pickable === false) {
            continue; // not drawn AND not given an id (skipped identically below)
        }
        if (pickFilter && !pickFilter(mesh)) {
            continue; // excluded from picking → not drawn AND not given an id (skipped identically below)
        }
        const gpu = mesh._gpu;
        const ti = mesh.thinInstances;
        const discardBG = pickDiscard && discardPipelines?.discardBGL ? createPickDiscardBindGroup(engine, discardPipelines.discardBGL, pickDiscard, mesh, tempBuffers) : null;
        const pipelines = discardPipelines && (!discardPipelines.discardBGL || discardBG) ? discardPipelines : defaultPipelines;

        if (ti) {
            if (ti.count <= 0 || !ti._gpuBuffer) {
                continue;
            }
            _tiUboU32[0] = nextId;
            const tiUbo = createUniformBuffer(engine, _tiUboView);
            tempBuffers.push(tiUbo);

            pass.setPipeline(pipelines.thinInstancePipeline);
            pass.setBindGroup(0, picker._sceneBG!);
            pass.setBindGroup(
                1,
                device.createBindGroup({
                    layout: pipelines.thinInstancePipeline.getBindGroupLayout(1),
                    entries: [
                        { binding: 0, resource: { buffer: tiUbo } },
                        { binding: 1, resource: { buffer: ti._gpuBuffer } },
                    ],
                })
            );
            if (discardBG) {
                pass.setBindGroup(2, discardBG);
            }
            pass.setVertexBuffer(0, gpu.positionBuffer);
            pass.setIndexBuffer(gpu.indexBuffer, gpu.indexFormat);
            pass.drawIndexed(gpu.indexCount, ti.count);
            nextId += ti.count;
        } else {
            _uboF32.set(mesh.worldMatrix, 0);
            _uboU32[16] = nextId;
            const meshUbo = createUniformBuffer(engine, _uboView);
            tempBuffers.push(meshUbo);
            let positionBuffer = gpu.positionBuffer;
            if (deformedGeometry && (mesh.morphTargets || mesh.skeleton) && mesh._cpuPositions) {
                const deformedPositions = deformedGeometry.computeDeformedPositions(mesh);
                if (deformedPositions) {
                    positionBuffer = createMappedBuffer(engine, deformedPositions, BU.VERTEX);
                    tempBuffers.push(positionBuffer);
                }
            }

            pass.setPipeline(pipelines.regularPipeline);
            pass.setBindGroup(0, picker._sceneBG!);
            pass.setBindGroup(
                1,
                device.createBindGroup({
                    layout: pipelines.regularPipeline.getBindGroupLayout(1),
                    entries: [{ binding: 0, resource: { buffer: meshUbo } }],
                })
            );
            if (discardBG) {
                pass.setBindGroup(2, discardBG);
            }
            pass.setVertexBuffer(0, positionBuffer);
            pass.setIndexBuffer(gpu.indexBuffer, gpu.indexFormat);
            pass.drawIndexed(gpu.indexCount);
            nextId++;
        }
    }

    // ── Gaussian-splatting meshes ────────────────────────────────────
    // Drawn from the same pass against the same depth target.  Each GS mesh
    // gets one pick id (no thin-instance support — BJS GS picking is per-mesh
    // too).  The GS picking pipeline applies an independent pickMatrix to the
    // GS clip-space output so the EWA Jacobian / `u.focal` math stays intact.
    const gsMeshes = (scene as unknown as { _gsMeshes: GaussianSplattingMesh[] })._gsMeshes;
    const gsMeshCount = gsMeshes.length;
    const gsNextIdStart = nextId;
    if (gsMeshCount > 0) {
        const gsModule = await import("./gs-picking-pipeline.js");
        gsModule.computeGsPickMatrix(_gsPickMatrix, px, py, w, h);
        gsModule.gsPickWritePickMatrixAndBind(pass, engine, _gsPickMatrix);
        const resMap = picker._gsMeshResources ?? (picker._gsMeshResources = new Map());
        for (let gi = 0; gi < gsMeshCount; gi++) {
            const gsMesh = gsMeshes[gi]!;
            let res = resMap.get(gsMesh);
            if (!res) {
                res = gsModule.createGsPickMeshResources(engine, gsMesh);
                resMap.set(gsMesh, res);
            }
            gsModule.drawGsForPicking(pass, engine, scene, gsMesh, res, nextId, w, h);
            nextId++;
        }
    }
    pass.end();

    // ── Readback (both 1×1 — trivially small) ────────────────────────
    encoder.copyTextureToBuffer({ texture: rt.colorTex }, { buffer: rt.colorStaging, bytesPerRow: 256 }, { width: 1, height: 1 });
    encoder.copyTextureToBuffer({ texture: rt.depthColorTex }, { buffer: rt.depthStaging, bytesPerRow: 256 }, { width: 1, height: 1 });
    device.queue.submit([encoder.finish()]);

    await Promise.all([rt.colorStaging.mapAsync(GPUMapMode.READ), rt.depthStaging.mapAsync(GPUMapMode.READ)]);

    const colorData = new U8(rt.colorStaging.getMappedRange());
    const pickId = (colorData[0]! << 16) | (colorData[1]! << 8) | colorData[2]!;
    const depth = new F32(rt.depthStaging.getMappedRange())[0]!;
    rt.colorStaging.unmap();
    rt.depthStaging.unmap();

    // Destroy temp per-mesh UBOs
    for (let i = 0; i < tempBuffers.length; i++) {
        tempBuffers[i]!.destroy();
    }

    // ── Resolve pick ID to mesh ──────────────────────────────────────
    if (pickId === 0) {
        if (debugLabel) {
            console.trace("pick-debug", {
                label: debugLabel,
                input: { x, y, pickX, pickY, px, py, backingWidth, backingHeight, clientWidth, clientHeight, viewport },
                ray: debugRay,
                pickId,
                depth,
                hit: false,
            });
        }
        return createEmptyPickingInfo();
    }
    let hitMesh: Mesh | GaussianSplattingMesh | null = null;
    let hitThinIdx = -1;
    let hitIsGs = false;
    let scanId = 1;
    for (let mi = 0; mi < meshCount; mi++) {
        const mesh = meshes[mi]!;
        if (mesh.pickable === false) {
            continue; // skipped identically to the draw pass above so scanId stays aligned with the ids
        }
        if (pickFilter && !pickFilter(mesh)) {
            continue; // skipped identically to the draw pass above so scanId stays aligned with the ids
        }
        const ti = mesh.thinInstances;
        if (ti) {
            if (ti.count <= 0 || !ti._gpuBuffer) {
                continue;
            }
            if (pickId >= scanId && pickId < scanId + ti.count) {
                hitMesh = mesh;
                hitThinIdx = pickId - scanId;
                break;
            }
            scanId += ti.count;
        } else {
            if (pickId === scanId) {
                hitMesh = mesh;
                break;
            }
            scanId++;
        }
    }
    if (!hitMesh && gsMeshCount > 0 && pickId >= gsNextIdStart) {
        const gsIdx = pickId - gsNextIdStart;
        if (gsIdx < gsMeshCount) {
            hitMesh = gsMeshes[gsIdx]!;
            hitIsGs = true;
        }
    }
    if (!hitMesh) {
        if (debugLabel) {
            console.trace("pick-debug", {
                label: debugLabel,
                input: { x, y, pickX, pickY, px, py, backingWidth, backingHeight, clientWidth, clientHeight, viewport },
                ray: debugRay,
                pickId,
                depth,
                hit: false,
                unresolved: true,
            });
        }
        return createEmptyPickingInfo();
    }

    const info = createEmptyPickingInfo();
    info.hit = true;
    info.pickedMesh = hitMesh;
    info.thinInstanceIndex = hitThinIdx;

    // Reconstruct world position from depth (using original full-res VP)
    const invVP = mat4Invert(vp);
    if (invVP) {
        const ndcX = (2 * (pickX - viewport.x)) / w - 1;
        const ndcY = 1 - (2 * (pickY - viewport.y)) / h;
        const wx = invVP[0]! * ndcX + invVP[4]! * ndcY + invVP[8]! * depth + invVP[12]!;
        const wy = invVP[1]! * ndcX + invVP[5]! * ndcY + invVP[9]! * depth + invVP[13]!;
        const wz = invVP[2]! * ndcX + invVP[6]! * ndcY + invVP[10]! * depth + invVP[14]!;
        const ww = invVP[3]! * ndcX + invVP[7]! * ndcY + invVP[11]! * depth + invVP[15]!;
        const invW = 1 / ww;
        info.pickedPoint = [wx * invW, wy * invW, wz * invW];

        const camPos = getCameraPosition(camera);
        const dx = info.pickedPoint[0] - camPos.x;
        const dy = info.pickedPoint[1] - camPos.y;
        const dz = info.pickedPoint[2] - camPos.z;
        info.distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    if (picker._detailedPick && !hitIsGs) {
        const ray = createPickingRay(pickX - viewport.x, pickY - viewport.y, vp, w, h);
        if (ray) {
            info.ray = ray;
            await picker._detailedPick(info, ray);
        }
    }
    if (debugLabel) {
        console.trace("pick-debug", {
            label: debugLabel,
            input: { x, y, pickX, pickY, px, py, backingWidth, backingHeight, clientWidth, clientHeight, viewport },
            ray: info.ray ?? debugRay,
            pickId,
            depth,
            hit: true,
            mesh: (hitMesh as Mesh).name ?? "(unnamed)",
            thinInstanceIndex: hitThinIdx,
            pickedPoint: info.pickedPoint,
            distance: info.distance,
        });
    }

    return info;
}

/**
 * Pick the mesh at CSS-space canvas coordinates, matching Babylon.js Scene.pick. Returns a PickingInfo.
 *
 * A picker's 1×1 readback targets (`PickTargets1x1.colorStaging`/`depthStaging`) are lazily created ONCE
 * and reused for every pick — cheap, but it means two overlapping `pickAsync` calls on the SAME picker
 * race `mapAsync` on those shared buffers ("Buffer already has an outstanding map pending", since a
 * GPUBuffer allows only one pending map at a time). This is easy to trigger from a consumer: e.g. a
 * cursor-following hover preview that GPU-picks on every pointermove, racing a pick fired by a click that
 * lands before the hover's pick has unmapped. Queue concurrent calls per-picker instead of rejecting: each
 * pick's full map/unmap cycle completes before the next one starts.
 */
export function pickAsync(picker: GpuPicker, x: number, y: number, options?: PickOptions): Promise<PickingInfo> {
    const prior = picker._pending ?? Promise.resolve();
    const run = prior.then(
        () => pickAsyncImpl(picker, x, y, options),
        () => pickAsyncImpl(picker, x, y, options) // a prior pick's rejection must not wedge the queue for this caller
    );
    // Swallow so a rejection here doesn't propagate into the NEXT caller's chain (each caller gets its own
    // `run` promise and observes the real rejection via the returned promise, not via `_pending`).
    picker._pending = run.then(
        () => undefined,
        () => undefined
    );
    return run;
}

/** Dispose GPU resources owned by this picker. */
export function disposePicker(picker: GpuPicker): void {
    if (picker._rt) {
        picker._rt.colorTex.destroy();
        picker._rt.depthColorTex.destroy();
        picker._rt.depthTex.destroy();
        picker._rt.colorStaging.destroy();
        picker._rt.depthStaging.destroy();
        picker._rt = null;
    }
    if (picker._sceneUbo) {
        picker._sceneUbo.destroy();
        picker._sceneUbo = null;
        picker._sceneBG = null;
    }
    if (picker._gsMeshResources) {
        // Async dispose — destroy() is synchronous so we can run inline once
        // the module is loaded.  If the module was never imported (no GS pick
        // ever happened) the map is empty and there's nothing to do.
        void import("./gs-picking-pipeline.js").then((m) => {
            if (!picker._gsMeshResources) {
                return;
            }
            for (const res of picker._gsMeshResources.values()) {
                m.disposeGsPickMeshResources(res);
            }
            picker._gsMeshResources = null;
        });
    }
}
