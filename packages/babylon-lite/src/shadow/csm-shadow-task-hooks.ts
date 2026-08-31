/** Internal CSM (cascaded shadow map) task hooks owned by CSM shadow generators.
 *
 *  Mirrors `pcf-shadow-task-hooks.ts`, but renders N cascade layers of a depth
 *  `texture_2d_array` and computes per-cascade frustum-split + orthographic-fit
 *  matrices from the active camera. All CSM-only math (frustum-corner fit,
 *  ortho-off-center, texel snap) lives here so plain ESM/PCF scenes never bundle
 *  it.
 */

import type { Camera } from "../camera/camera.js";
import type { DirectionalLight } from "../light/directional-light.js";
import type { EngineContext } from "../engine/engine.js";
import type { Material, MaterialView } from "../material/material.js";
import type { Mesh } from "../mesh/mesh.js";
import type { RenderTarget } from "../engine/render-target.js";
import type { SceneContext } from "../scene/scene-core.js";
import { createRenderTask, removeMeshFromTask, type RenderTask } from "../frame-graph/render-task.js";
import { getViewProjectionMatrix, getEffectiveAspectRatio, _cameraChangeKey } from "../camera/camera.js";
import { mat4InvertToRef } from "../math/mat4-invert-to-ref.js";
import { casterVersionSum, createShadowCamera, updateShadowCameraBase } from "./shadow-base.js";
import { getNoColorView, preloadPcfShadowTaskState } from "./pcf-shadow-task-hooks.js";
import type { ShadowGenerator, ShadowTaskInternalState } from "./shadow-generator.js";
import { retireGpuResources } from "../engine/gpu-resource-retirement.js";

/** Generation of the material that ACTUALLY casts this caster mesh's shadow — the explicit
 *  `_shadowCasterMaterial` override when set, else the mesh's own material. Lets the caster-set diff detect a
 *  rebuild of the override caster material (which would otherwise be invisible to a check on the receive material). */
function effectiveCasterGen(material: Material): number {
    const eff = material._shadowCasterMaterial ?? material;
    return (eff as { _csmGen?: number })._csmGen ?? 0;
}

/** CSM configuration captured by the generator and consumed by these hooks. */
export interface CsmConfig {
    /** @internal */
    _numCascades: number;
    /** @internal */
    _lambda: number;
    /** @internal */
    _cascadeBlendPercentage: number;
    /** @internal */
    _stabilizeCascades: boolean;
    /** @internal */
    _shadowMaxZ: number | null;
    /** @internal */
    _bias: number;
    /** @internal */
    _worldSpaceBias: number | null;
    /** @internal */
    _darkness: number;
    /** @internal */
    _frustumEdgeFalloff: number;
    /** @internal */
    _mapSize: number;
    /** @internal */
    _forceRefreshEveryFrame: boolean;
}

export interface CsmTaskState extends ShadowTaskInternalState {
    /** @internal */
    _tasks: RenderTask[];
    /** @internal */
    _cameras: Camera[];
    /** @internal */
    _scene: SceneContext;
    /** @internal */
    _cameraVersion: number;
    /** @internal */
    _lastCasterVersion: number;
    /** @internal */
    _lastLightVersion: number;
    /** @internal */
    _lastCamVersion: number;
    /** @internal Effective aspect ratio the cascades were last fit against. */
    _lastCamAspect: number;
    /** @internal */
    _uboData: Float32Array;
    /** @internal */
    _casterMeshes: readonly Mesh[];
    /** @internal Scene renderable version the cascade material views were built against. A material
     *  swap (plugin/receiver variant change) rebuilds the swapped mesh's renderable + UBOs but leaves
     *  this task's cached no-color material views pointing at the now-destroyed UBOs, so we rebuild when
     *  the MATERIAL EPOCH changes — not on every renderable-version bump (a geometry resize bumps the
     *  renderable version without touching materials, and is handled by a cheap re-record instead). */
    _renderableVersion: number;
    /** @internal Scene material epoch the cascade material views were built against (see `_renderableVersion`). */
    _materialEpoch: number;
    /** @internal Cached per-material no-color depth views, reused when a caster is added incrementally so a pure
     *  caster-set change updates the existing cascade tasks instead of rebuilding and re-resolving every caster
     *  (which leaked ~casters×cascades UBO handles each time the caster list was re-supplied). */
    _materialViews: Map<Material, MaterialView>;
    /** @internal Per-caster-material generation (`_csmGen`) snapshot at build. The incremental path is taken only
     *  while every current caster's material gen is unchanged — i.e. no CASTER material was rebuilt (which would
     *  leave its cached no-color view dangling). This is precise, unlike the global `_materialEpoch` which also
     *  bumps for swaps of unrelated (non-caster) materials. */
    _casterMatGens: Map<Material, number>;
    /** @internal Per-caster cascade-cap snapshot used to update task membership incrementally. */
    _casterMaxCascades: Map<Mesh, number | undefined>;
    /** @internal Pre-allocated scratch storage for per-frame cascade computation, sized for `_numCascades`. */
    _cascadeScratch: CsmCascadeScratch;
}

/** @internal Pre-allocated scratch buffers for zero-allocation cascade fitting. */
interface CsmCascadeScratch {
    /** Shared CsmCascades result object mutated in place each frame. */
    _cascades: CsmCascades;
    /** Reusable temporary light-view matrix. */
    _view: Float32Array;
    /** Inverse view-projection matrix (16 floats). */
    _invViewProj: Float32Array;
    /** Eight reusable frustum corner vectors. */
    _corners: number[][];
    /** Caster world AABB as min xyz followed by max xyz. */
    _aabb: number[];
}

export const preloadCsmShadowTaskState = preloadPcfShadowTaskState;

/** @internal Allocate fixed-size scratch storage for zero-allocation per-frame cascade fitting. */
export function _createCascadeScratch(n: number): CsmCascadeScratch {
    const transforms: Float32Array[] = [];
    const views: Float32Array[] = [];
    for (let i = 0; i < n; i++) {
        transforms.push(new Float32Array(16));
        views.push(new Float32Array(16));
    }
    return {
        _cascades: {
            _transforms: transforms,
            _views: views,
            _near: new Array<number>(n).fill(0),
            _far: new Array<number>(n).fill(0),
            _viewFrustumZ: new Array<number>(n).fill(0),
            _frustumLengths: new Array<number>(n).fill(0),
        },
        _view: new Float32Array(16),
        _invViewProj: new Float32Array(16),
        _corners: Array.from({ length: 8 }, () => [0, 0, 0]),
        _aabb: [0, 0, 0, 0, 0, 0],
    };
}

/** Build (or reuse) the CSM task state: N per-layer depth render targets + cameras + tasks. */
export function ensureCsmShadowTaskState(
    engine: EngineContext,
    scene: SceneContext,
    sg: ShadowGenerator,
    cfg: CsmConfig,
    casterMeshes: readonly Mesh[],
    existingState: ShadowTaskInternalState | null
): CsmTaskState {
    const existing = existingState as CsmTaskState | null;
    if (existing) {
        if (existing._casterMeshes === casterMeshes && existing._renderableVersion === scene._renderableVersion) {
            return existing;
        }
        // The caster set is unchanged and NO material was rebuilt/swapped since these tasks were built (the
        // material epoch matches): the only thing that changed is geometry (e.g. resizeMeshGeometry reallocated
        // a caster's GPU buffers, bumping the renderable version). The cascade tasks' cached no-color material
        // views are still valid — only the bundles need refreshing to pick up the new buffer handles, which the
        // shadow scheduler's execute() already does (it re-records when the renderable version moves). So adopt
        // the new state markers and REUSE the existing tasks instead of recreating them — recreating tasks every
        // geometry edit re-compiles pipelines + churns bind-groups/bundles for the whole caster set (multi-MB,
        // never returned by the GPU allocator). Only a real material change (epoch bump) needs a full rebuild,
        // because that destroys the caster UBOs the cached views point at.
        if (existing._casterMeshes === casterMeshes && existing._materialEpoch === scene._materialEpoch) {
            existing._renderableVersion = scene._renderableVersion;
            return existing;
        }
        // The caster SET changed (different array). Decide INCREMENTAL vs full rebuild by whether any CURRENT
        // caster's OWN material was rebuilt since we built (its cached no-color view would dangle) — tracked via
        // a precise per-material gen, NOT the global `_materialEpoch` (which also bumps when an UNRELATED, non-
        // caster material is swapped, e.g. a lit scene mesh added near a caster set re-supply). If NO caster
        // material changed, update the cascade tasks IN PLACE: keep the unchanged casters' resolved depth packets
        // (so nothing is destroyed — no "buffer used in submit while destroyed" — and nothing leaks — the old
        // code re-resolved EVERY caster into fresh per-cascade UBO packets and never freed the prior ones,
        // leaking ~casters×cascades handles every time the caster list was re-supplied, which a consumer may do
        // per frame). Only add the new casters / drop departed ones (a regenerated caster's old packet is freed
        // by removeFromScene when its mesh is disposed; a persistent caster simply keeps its packet).
        let casterMatChanged = false;
        for (const m of casterMeshes) {
            const mat = m.material;
            if (!mat) {
                continue;
            }
            const stored = existing._casterMatGens.get(mat);
            if (stored !== undefined && stored !== effectiveCasterGen(mat)) {
                casterMatChanged = true;
                break;
            }
        }
        if (!casterMatChanged) {
            const nextSet = new Set(casterMeshes);
            const views = existing._materialViews;
            const gens = existing._casterMatGens;
            const caps = existing._casterMaxCascades;
            const tasks = existing._tasks;
            for (const m of existing._casterMeshes) {
                if (!nextSet.has(m) || m._shadowMaxCascade !== caps.get(m)) {
                    caps.delete(m);
                    for (const t of tasks) {
                        removeMeshFromTask(t, m);
                    }
                }
            }
            for (const m of casterMeshes) {
                const maxCascade = m._shadowMaxCascade;
                if (!caps.has(m) && m.material) {
                    const view = getNoColorView(m.material, views);
                    for (let c = 0; c < tasks.length; c++) {
                        if (c <= (maxCascade ?? c)) {
                            tasks[c]!.addMesh(m, { material: view });
                        }
                    }
                    gens.set(m.material, effectiveCasterGen(m.material));
                }
                caps.set(m, maxCascade);
            }
            // Force each cascade to re-resolve its newly-added pending casters + re-bucket its binding lists.
            for (const t of tasks) {
                t._lastVersion = -1;
            }
            existing._casterMeshes = casterMeshes;
            existing._renderableVersion = scene._renderableVersion;
            return existing;
        }
        // A CASTER material was actually rebuilt (a material swap rebuilds its renderable + UBOs but
        // leaves our cached no-color material views dangling at the destroyed UBOs — the
        // "Buffer used in submit while destroyed" flood seen when a caster's material swaps variant on first
        // render). Rebuild the cascade tasks below with the casters' CURRENT materials and return the NEW
        // state — the caller swaps to it, so the OLD task is never recorded again. Its GPU buffers may still
        // be referenced by the next frame command buffer, especially during async pre-first-frame construction,
        // so retire it only after that frame has submitted and drained. Mirrors resizeMeshGeometry.
        retireGpuResources(engine, existing._task.dispose);
    }

    const materialViews = new Map<Material, MaterialView>();
    const n = cfg._numCascades;
    const tasks: RenderTask[] = [];
    const cameras: Camera[] = [];
    for (let i = 0; i < n; i++) {
        const layerView = sg._depthTexture.createView({ dimension: "2d", baseArrayLayer: i, arrayLayerCount: 1 });
        const rt: RenderTarget = {
            _descriptor: {
                size: { width: cfg._mapSize, height: cfg._mapSize },
                dFormat: "depth32float",
                _depthClearValue: 1,
                _depthCompare: "less-equal",
                samples: 1,
            },
            _colorTexture: null,
            _colorView: null,
            _depthTexture: sg._depthTexture,
            _depthView: layerView,
            _width: cfg._mapSize,
            _height: cfg._mapSize,
            _eager: true,
            _ownsDepthTexture: false, // borrowed: the shared CSM depth array is owned by the generator
        };
        const camera = createShadowCamera(sg);
        const task = createRenderTask({ name: `csm${i}`, rt, clr: true, cam: camera, _skipClusteredLights: true }, engine, scene);
        for (const mesh of casterMeshes) {
            const material = mesh.material;
            // Per-caster cascade cap: a capped caster renders only into layers 0..maxCascade (its far-layer
            // shadow is sub-texel anyway), saving the excluded layers' draws + pipeline switches.
            if (material && i <= (mesh._shadowMaxCascade ?? i)) {
                task.addMesh(mesh, { material: getNoColorView(material, materialViews) });
            }
        }
        tasks.push(task);
        cameras.push(camera);
    }

    const compositeTask = {
        record(): void {
            for (const t of tasks) {
                t.record();
            }
        },
        execute(): number {
            let draws = 0;
            for (const t of tasks) {
                draws += t.execute?.() ?? 0;
            }
            return draws;
        },
        dispose(): void {
            for (const t of tasks) {
                t.dispose();
            }
        },
    };

    // Snapshot each caster material's gen so the next caster-set change can tell whether a CASTER material was
    // rebuilt (→ full rebuild) or only the set changed (→ incremental, keeping unchanged casters' packets).
    const casterMatGens = new Map<Material, number>();
    const casterMaxCascades = new Map<Mesh, number | undefined>();
    for (const m of casterMeshes) {
        casterMaxCascades.set(m, m._shadowMaxCascade);
        if (m.material) {
            casterMatGens.set(m.material, effectiveCasterGen(m.material));
        }
    }
    return {
        _task: compositeTask,
        _tasks: tasks,
        _cameras: cameras,
        _scene: scene,
        _cameraVersion: 0,
        _lastCasterVersion: -1,
        _lastLightVersion: -1,
        _lastCamVersion: -1,
        _lastCamAspect: -1,
        _uboData: new Float32Array(80),
        _casterMeshes: casterMeshes,
        _renderableVersion: scene._renderableVersion,
        _materialEpoch: scene._materialEpoch,
        _materialViews: materialViews,
        _casterMatGens: casterMatGens,
        _casterMaxCascades: casterMaxCascades,
        _cascadeScratch: _createCascadeScratch(n),
    };
}

/** Render every cascade layer for this frame, recomputing splits/matrices from the active camera. */
export function renderCsmShadowMap(engine: EngineContext, sg: ShadowGenerator, state: CsmTaskState, cfg: CsmConfig): number {
    const casterMeshes = state._casterMeshes;
    const camera = state._scene.camera;
    if (!camera) {
        return 0;
    }
    const casterVersion = casterVersionSum(casterMeshes);
    const lightVersion = sg._light.worldMatrixVersion;
    const camVersion = _cameraChangeKey(camera);
    // Effective aspect is part of the key: a viewport or surface resize changes the camera
    // frustum the cascades are fit to while every version above stays put.
    const camAspect = csmCameraAspect(state._scene, camera);
    if (
        !cfg._forceRefreshEveryFrame &&
        casterVersion === state._lastCasterVersion &&
        lightVersion === state._lastLightVersion &&
        camVersion === state._lastCamVersion &&
        camAspect === state._lastCamAspect
    ) {
        return 0;
    }

    const cascades = _computeCsmCascades(state._scene, camera, sg._light as DirectionalLight, cfg, state._casterMeshes, state._cascadeScratch);

    _writeCsmUbo(state._uboData, cascades, cfg);
    sg._version++;
    engine._device.queue.writeBuffer(sg._shadowUBO, 0, state._uboData as Float32Array<ArrayBuffer>);

    const receiverCbs = sg._onReceiverData;
    if (receiverCbs) {
        for (let i = 0; i < receiverCbs.length; i++) {
            receiverCbs[i]!(state._uboData);
        }
    }

    state._cameraVersion++;
    for (let i = 0; i < cascades._transforms.length; i++) {
        const cam = state._cameras[i]!;
        cam.fov = 1;
        const clipBias = cfg._worldSpaceBias === null ? cfg._bias * 0.5 : csmWorldBiasClipOffset(cfg._worldSpaceBias, cascades._near[i]!, cascades._far[i]!);
        _biasViewProjection(cascades._transforms[i]!, clipBias);
        updateShadowCameraBase(cam, state._cameraVersion, cascades._near[i]!, cascades._far[i]!, cascades._views[i]!, cascades._transforms[i]!);
    }

    state._lastCasterVersion = casterVersion;
    state._lastLightVersion = lightVersion;
    state._lastCamVersion = camVersion;
    state._lastCamAspect = camAspect;
    return state._task.execute?.() ?? 0;
}

// ─── CSM math (isolated to this module) ─────────────────────────────

export interface CsmCascades {
    /** @internal Receiver transform per cascade (col-major), clip-biased in place after the receiver UBO is written. */
    _transforms: Float32Array[];
    /** @internal Cascade light view matrix per cascade (col-major). */
    _views: Float32Array[];
    /** @internal Ortho near per cascade. */
    _near: number[];
    /** @internal Ortho far per cascade. */
    _far: number[];
    /** @internal Camera-view-space split distance per cascade. */
    _viewFrustumZ: number[];
    /** @internal Slice length per cascade. */
    _frustumLengths: number[];
}

/** Lite reverse-Z NDC frustum corners (near z=1, far z=0); xy each -1 or +1. */
const FRUSTUM_NDC: ReadonlyArray<readonly [number, number, number]> = [
    [-1, 1, 1],
    [1, 1, 1],
    [1, -1, 1],
    [-1, -1, 1],
    [-1, 1, 0],
    [1, 1, 0],
    [1, -1, 0],
    [-1, -1, 0],
];
const DEFAULT_BOUND_MIN = [-0.5, -0.5, -0.5] as const;
const DEFAULT_BOUND_MAX = [0.5, 0.5, 0.5] as const;

/** @internal Build a light-space view matrix into caller-owned storage. */
export function buildLightViewMatrixInto(out: Float32Array, dirX: number, dirY: number, dirZ: number, px: number, py: number, pz: number): void {
    const len = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ) || 1;
    const fx = dirX / len;
    const fy = dirY / len;
    const fz = dirZ / len;
    let upX = 0;
    let upY = 1;
    let upZ = 0;
    if (Math.abs(fy) > 0.99) {
        upX = 0;
        upY = 0;
        upZ = 1;
    }
    let rx = upY * fz - upZ * fy;
    let ry = upZ * fx - upX * fz;
    let rz = upX * fy - upY * fx;
    const rLen = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1;
    rx /= rLen;
    ry /= rLen;
    rz /= rLen;
    const ux = fy * rz - fz * ry;
    const uy = fz * rx - fx * rz;
    const uz = fx * ry - fy * rx;
    out[0] = rx;
    out[1] = ux;
    out[2] = fx;
    out[3] = 0;
    out[4] = ry;
    out[5] = uy;
    out[6] = fy;
    out[7] = 0;
    out[8] = rz;
    out[9] = uz;
    out[10] = fz;
    out[11] = 0;
    out[12] = -(rx * px + ry * py + rz * pz);
    out[13] = -(ux * px + uy * py + uz * pz);
    out[14] = -(fx * px + fy * py + fz * pz);
    out[15] = 1;
}

/** Transform a point by a 4×4 column-major matrix with perspective divide. */
function transformCoordInto(out: number[], m: ArrayLike<number>, x: number, y: number, z: number): void {
    const X = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
    const Y = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
    const Z = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
    const W = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
    out[0] = X / W;
    out[1] = Y / W;
    out[2] = Z / W;
}

/** Multiply an orthographic off-center projection directly by an affine light view. */
function orthoViewInto(out: Float32Array, view: Float32Array, l: number, r: number, b: number, t: number, n: number, f: number): void {
    const sx = 2 / (r - l);
    const sy = 2 / (t - b);
    const sz = 1 / (f - n);
    const tx = -(r + l) / (r - l);
    const ty = -(t + b) / (t - b);
    const tz = -n / (f - n);
    for (let column = 0; column < 4; column++) {
        const i = column * 4;
        const w = view[i + 3]!;
        out[i] = sx * view[i]! + tx * w;
        out[i + 1] = sy * view[i + 1]! + ty * w;
        out[i + 2] = sz * view[i + 2]! + tz * w;
        out[i + 3] = w;
    }
}

/** Effective aspect of the surface the scene actually renders into.
 *
 *  Not `engine.canvas`: a scene is bound to `scene.surface` (an `EngineContext` is itself a
 *  `SurfaceContext`, so that is the canvas for the common single-surface case, but an
 *  auxiliary surface created via `createSurface` has its own swapchain size). Fitting
 *  cascades to the canvas would use a frustum the scene never draws. `getEffectiveAspectRatio`
 *  additionally folds in the camera's normalized viewport, matching `_writePassSceneUBO`. */
export function csmCameraAspect(scene: SceneContext, camera: Camera): number {
    const rt = scene.surface.scRT;
    return getEffectiveAspectRatio(camera, rt._width, rt._height);
}

export function _computeCsmCascades(
    scene: SceneContext,
    camera: Camera,
    light: DirectionalLight,
    cfg: CsmConfig,
    casterMeshes: readonly Mesh[],
    scratch: CsmCascadeScratch
): CsmCascades {
    const near = camera.nearPlane;
    const far = camera.farPlane;
    const cameraRange = far - near;
    const shadowMaxZ = cfg._shadowMaxZ ?? far;
    const maxDistance = shadowMaxZ < far && shadowMaxZ >= near ? Math.min((shadowMaxZ - near) / (far - near), 1) : 1;
    const minDistance = 0;
    const minZ = near + minDistance * cameraRange;
    const maxZ = near + maxDistance * cameraRange;
    const range = maxZ - minZ;
    const ratio = maxZ / minZ;
    const n = cfg._numCascades;

    const cascades = scratch._cascades;
    const corners = scratch._corners;

    // Reuse stable arrays for split computation
    const viewFrustumZ = cascades._viewFrustumZ;
    const frustumLengths = cascades._frustumLengths;
    for (let i = 0; i < n; i++) {
        const p = (i + 1) / n;
        const log = minZ * ratio ** p;
        const uniform = minZ + range * p;
        const d = cfg._lambda * (log - uniform) + uniform;
        frustumLengths[i] = d - (i === 0 ? minZ : viewFrustumZ[i - 1]!);
        viewFrustumZ[i] = d;
    }

    // Light direction (normalized), avoiding a perfectly vertical degenerate case.
    let dx = light.direction.x;
    let dy = light.direction.y;
    let dz = light.direction.z;
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl;
    dy /= dl;
    dz /= dl;
    if (Math.abs(dy) >= 1) {
        dz = 1e-13;
    }

    // Effective aspect, not the raw canvas ratio: a camera with a normalized viewport renders
    const aspect = csmCameraAspect(scene, camera);
    const vp = getViewProjectionMatrix(camera, aspect) as unknown as ArrayLike<number>;
    const invViewProj = scratch._invViewProj;
    mat4InvertToRef(vp as never, invViewProj as never);

    const hasCasterBounds = _castersWorldAabbInto(casterMeshes, scratch);

    let prevSplit = 0;
    for (let c = 0; c < n; c++) {
        const split = prevSplit + frustumLengths[c]! / cameraRange;

        // World-space frustum corners of this slice.
        for (let k = 0; k < 8; k++) {
            const ndc = FRUSTUM_NDC[k]!;
            transformCoordInto(corners[k]!, invViewProj, ndc[0], ndc[1], ndc[2]);
        }
        // Interpolate near/far corners to cascade slice boundaries
        for (let k = 0; k < 4; k++) {
            const nearCorner = corners[k]!;
            const farCorner = corners[k + 4]!;
            const rx = farCorner[0]! - nearCorner[0]!;
            const ry = farCorner[1]! - nearCorner[1]!;
            const rz = farCorner[2]! - nearCorner[2]!;
            farCorner[0] = nearCorner[0]! + rx * split;
            farCorner[1] = nearCorner[1]! + ry * split;
            farCorner[2] = nearCorner[2]! + rz * split;
            nearCorner[0] = nearCorner[0]! + rx * prevSplit;
            nearCorner[1] = nearCorner[1]! + ry * prevSplit;
            nearCorner[2] = nearCorner[2]! + rz * prevSplit;
        }
        prevSplit = split;

        // Centroid.
        let cx = 0,
            cy = 0,
            cz = 0;
        for (const corner of corners) {
            cx += corner[0]!;
            cy += corner[1]!;
            cz += corner[2]!;
        }
        cx /= 8;
        cy /= 8;
        cz /= 8;

        let minX: number, maxX: number, minY: number, maxY: number, minEz: number, maxEz: number;
        let stableRadius = 0;

        const viewBuf = scratch._view;

        if (cfg._stabilizeCascades) {
            let radius = 0;
            for (const corner of corners) {
                radius = Math.max(radius, Math.hypot(corner[0]! - cx, corner[1]! - cy, corner[2]! - cz));
            }
            radius = Math.ceil(radius * 16) / 16;
            stableRadius = radius;
            minX = minY = minEz = -radius;
            maxX = maxY = maxEz = radius;
        } else {
            // Temp light view centred on the centroid to fit a tight AABB.
            buildLightViewMatrixInto(viewBuf, dx, dy, dz, cx, cy, cz);
            minX = minY = minEz = Infinity;
            maxX = maxY = maxEz = -Infinity;
            for (const corner of corners) {
                transformCoordInto(corner, viewBuf, corner[0]!, corner[1]!, corner[2]!);
                minX = Math.min(minX, corner[0]!);
                maxX = Math.max(maxX, corner[0]!);
                minY = Math.min(minY, corner[1]!);
                maxY = Math.max(maxY, corner[1]!);
                minEz = Math.min(minEz, corner[2]!);
                maxEz = Math.max(maxEz, corner[2]!);
            }
        }

        // Shadow camera sits behind the slice along the light direction.
        const eyeX = cx + dx * minEz;
        const eyeY = cy + dy * minEz;
        const eyeZ = cz + dz * minEz;
        const view = cascades._views[c]!;
        buildLightViewMatrixInto(view, dx, dy, dz, eyeX, eyeY, eyeZ);

        let viewMinZ = 0;
        let viewMaxZ = maxEz - minEz;

        // Tighten Z to the caster bounding box in cascade view space (depthClamp = false behaviour:
        // keep all casters inside the frustum so no GPU depth-clip feature is required).
        if (hasCasterBounds) {
            const aabb = scratch._aabb;
            let cMinZ = Infinity;
            let cMaxZ = -Infinity;
            for (let k = 0; k < 8; k++) {
                const wx = aabb[k & 1 ? 3 : 0]!;
                const wy = aabb[k & 2 ? 4 : 1]!;
                const wz = aabb[k & 4 ? 5 : 2]!;
                const lz = view[2]! * wx + view[6]! * wy + view[10]! * wz + view[14]!;
                cMinZ = Math.min(cMinZ, lz);
                cMaxZ = Math.max(cMaxZ, lz);
            }
            if (cMinZ <= viewMaxZ) {
                viewMinZ = Math.min(viewMinZ, cMinZ);
                viewMaxZ = Math.min(viewMaxZ, cMaxZ);
            }
        }

        // The caster matrix adds the world-space bias toward clip Z=1. Reserve the same distance at the far plane
        // so geometry on the tightly fitted caster bound remains inside the clip volume after that offset.
        if (cfg._worldSpaceBias) {
            viewMaxZ += cfg._worldSpaceBias;
        }

        const transform = cascades._transforms[c]!;
        orthoViewInto(transform, view, minX, maxX, minY, maxY, viewMinZ, viewMaxZ);

        // Texel-snap
        let aClipX = transform[12]!;
        let aClipY = transform[13]!;
        if (cfg._stabilizeCascades && stableRadius > 0) {
            const texelWorld = (2 * stableRadius) / cfg._mapSize;
            const anchorX = Math.round((view[0]! * cx + view[4]! * cy + view[8]! * cz) / texelWorld) * texelWorld;
            const anchorY = Math.round((view[1]! * cx + view[5]! * cy + view[9]! * cz) / texelWorld) * texelWorld;
            aClipX += anchorX / stableRadius;
            aClipY += anchorY / stableRadius;
        }
        const ox = aClipX * (cfg._mapSize / 2);
        const oy = aClipY * (cfg._mapSize / 2);
        const offX = (Math.round(ox) - ox) * (2 / cfg._mapSize);
        const offY = (Math.round(oy) - oy) * (2 / cfg._mapSize);
        transform[12] = transform[12]! + offX;
        transform[13] = transform[13]! + offY;

        cascades._near[c] = viewMinZ;
        cascades._far[c] = viewMaxZ;
    }

    return cascades;
}

/** Write the casters' world AABB into scratch-owned storage. */
function _castersWorldAabbInto(casterMeshes: readonly Mesh[], scratch: CsmCascadeScratch): boolean {
    const aabb = scratch._aabb;
    let minX = Infinity,
        minY = Infinity,
        minZ = Infinity,
        maxX = -Infinity,
        maxY = -Infinity,
        maxZ = -Infinity;
    for (const mesh of casterMeshes) {
        const ti = mesh.thinInstances;
        if (ti && ti.count > 0 && ti.matrices) {
            const cached = _thinInstanceWorldAabb(mesh, ti);
            if (cached) {
                const bounds = cached._bounds;
                minX = Math.min(minX, bounds[0]!);
                minY = Math.min(minY, bounds[1]!);
                minZ = Math.min(minZ, bounds[2]!);
                maxX = Math.max(maxX, bounds[3]!);
                maxY = Math.max(maxY, bounds[4]!);
                maxZ = Math.max(maxZ, bounds[5]!);
            }
            continue;
        }
        const world = mesh.worldMatrix;
        const bmin = mesh.boundMin ?? DEFAULT_BOUND_MIN;
        const bmax = mesh.boundMax ?? DEFAULT_BOUND_MAX;
        for (let k = 0; k < 8; k++) {
            const lx = k & 1 ? bmax[0]! : bmin[0]!;
            const ly = k & 2 ? bmax[1]! : bmin[1]!;
            const lz = k & 4 ? bmax[2]! : bmin[2]!;
            const wx = world[0]! * lx + world[4]! * ly + world[8]! * lz + world[12]!;
            const wy = world[1]! * lx + world[5]! * ly + world[9]! * lz + world[13]!;
            const wz = world[2]! * lx + world[6]! * ly + world[10]! * lz + world[14]!;
            minX = Math.min(minX, wx);
            minY = Math.min(minY, wy);
            minZ = Math.min(minZ, wz);
            maxX = Math.max(maxX, wx);
            maxY = Math.max(maxY, wy);
            maxZ = Math.max(maxZ, wz);
        }
    }
    if (!Number.isFinite(minX)) {
        return false;
    }
    aabb[0] = minX;
    aabb[1] = minY;
    aabb[2] = minZ;
    aabb[3] = maxX;
    aabb[4] = maxY;
    aabb[5] = maxZ;
    return true;
}

interface ThinCasterAabbEntry {
    _version: number;
    _worldVersion: number;
    _bounds: number[];
}

/** Per-mesh cache of a thin-instanced caster's world AABB.
 *  Lazily allocated so this module keeps zero import-time side effects and stays tree-shakable. */
let _thinCasterAabbCache: WeakMap<Mesh, ThinCasterAabbEntry> | null = null;
function _getThinCasterAabbCache(): WeakMap<Mesh, ThinCasterAabbEntry> {
    if (!_thinCasterAabbCache) {
        _thinCasterAabbCache = new WeakMap();
    }
    return _thinCasterAabbCache;
}

/** Compute a thin-instanced caster's world AABB in a stable cache entry. */
function _thinInstanceWorldAabb(mesh: Mesh, ti: NonNullable<Mesh["thinInstances"]>): ThinCasterAabbEntry | null {
    const cache = _getThinCasterAabbCache();
    const worldVersion = mesh.worldMatrixVersion;
    let entry = cache.get(mesh);
    if (entry && entry._version === ti._version && entry._worldVersion === worldVersion) {
        return Number.isFinite(entry._bounds[0]) ? entry : null;
    }
    if (!entry) {
        entry = { _version: 0, _worldVersion: 0, _bounds: [0, 0, 0, 0, 0, 0] };
        cache.set(mesh, entry);
    }
    // Hoist the prototype world matrix once (worldMatrix is a getter) — it is constant across all instances.
    const world = mesh.worldMatrix;
    const bmin = mesh.boundMin ?? DEFAULT_BOUND_MIN;
    const bmax = mesh.boundMax ?? DEFAULT_BOUND_MAX;
    const mats = ti.matrices;
    const count = Math.min(ti.count, (mats.length / 16) | 0);
    let minX = Infinity,
        minY = Infinity,
        minZ = Infinity,
        maxX = -Infinity,
        maxY = -Infinity,
        maxZ = -Infinity;
    for (let i = 0; i < count; i++) {
        const o = i * 16;
        // Skip parked instances (zero 3×3 linear part → zero-area triangles that rasterize to nothing).
        const lin =
            Math.abs(mats[o]!) +
            Math.abs(mats[o + 1]!) +
            Math.abs(mats[o + 2]!) +
            Math.abs(mats[o + 4]!) +
            Math.abs(mats[o + 5]!) +
            Math.abs(mats[o + 6]!) +
            Math.abs(mats[o + 8]!) +
            Math.abs(mats[o + 9]!) +
            Math.abs(mats[o + 10]!);
        if (lin < 1e-9) {
            continue;
        }
        for (let k = 0; k < 8; k++) {
            const lx = k & 1 ? bmax[0]! : bmin[0]!;
            const ly = k & 2 ? bmax[1]! : bmin[1]!;
            const lz = k & 4 ? bmax[2]! : bmin[2]!;
            // 1) instance-local: ip = instanceMatrix * localCorner
            const ix = mats[o]! * lx + mats[o + 4]! * ly + mats[o + 8]! * lz + mats[o + 12]!;
            const iy = mats[o + 1]! * lx + mats[o + 5]! * ly + mats[o + 9]! * lz + mats[o + 13]!;
            const iz = mats[o + 2]! * lx + mats[o + 6]! * ly + mats[o + 10]! * lz + mats[o + 14]!;
            // 2) world: wp = mesh.world * ip  (matches finalWorld = mesh.world * instanceMatrix)
            const wx = world[0]! * ix + world[4]! * iy + world[8]! * iz + world[12]!;
            const wy = world[1]! * ix + world[5]! * iy + world[9]! * iz + world[13]!;
            const wz = world[2]! * ix + world[6]! * iy + world[10]! * iz + world[14]!;
            minX = Math.min(minX, wx);
            minY = Math.min(minY, wy);
            minZ = Math.min(minZ, wz);
            maxX = Math.max(maxX, wx);
            maxY = Math.max(maxY, wy);
            maxZ = Math.max(maxZ, wz);
        }
    }
    entry._version = ti._version;
    entry._worldVersion = worldVersion;
    const bounds = entry._bounds;
    if (!Number.isFinite(minX)) {
        bounds[0] = Infinity;
        return null;
    }
    bounds[0] = minX;
    bounds[1] = minY;
    bounds[2] = minZ;
    bounds[3] = maxX;
    bounds[4] = maxY;
    bounds[5] = maxZ;
    return entry;
}

export function _writeCsmUbo(out: Float32Array, cascades: CsmCascades, cfg: CsmConfig): void {
    out.fill(0);
    const n = cascades._transforms.length;
    for (let i = 0; i < n; i++) {
        out.set(cascades._transforms[i]!, i * 16);
    }
    for (let i = 0; i < n; i++) {
        out[64 + i] = cascades._viewFrustumZ[i]!;
        out[68 + i] = cascades._frustumLengths[i]!;
    }
    out[72] = cfg._darkness;
    out[73] = cfg._mapSize;
    out[74] = 1 / cfg._mapSize;
    out[75] = cfg._frustumEdgeFalloff;
    out[76] = n;
    out[77] = cfg._cascadeBlendPercentage === 0 ? 10000 : 1 / cfg._cascadeBlendPercentage;
}

/** @internal Convert a physical caster offset to the clip-space Z offset for one orthographic cascade. */
export function csmWorldBiasClipOffset(worldSpaceBias: number, near: number, far: number): number {
    const range = far - near;
    if (!Number.isFinite(worldSpaceBias) || worldSpaceBias <= 0 || !Number.isFinite(range) || range <= 0) {
        return 0;
    }
    return worldSpaceBias / range;
}

/** @internal Apply clip-space Z bias to a view-projection matrix. */
export function _biasViewProjection(matrix: Float32Array, clipOffset: number): void {
    matrix[14] = matrix[14]! + clipOffset;
}
