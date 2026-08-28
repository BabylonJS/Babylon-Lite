/** Internal CSM (cascaded shadow map) task hooks owned by CSM shadow generators.
 *
 *  Mirrors `pcf-shadow-task-hooks.ts`, but renders N cascade layers of a depth
 *  `texture_2d_array` and computes per-cascade frustum-split + orthographic-fit
 *  matrices from the active camera. All CSM-only math (frustum-corner fit,
 *  ortho-off-center, texel snap) lives here so plain ESM/PCF scenes never bundle
 *  it. The light view matrix + 4×4 multiply are shared helpers (already used by
 *  ESM/PCF) so reusing them adds zero bytes.
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
import { buildLightViewMatrixInto, casterVersionSum, createShadowCamera, multiply4x4Into, updateShadowCameraBase } from "./shadow-base.js";
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
    /** Number of cascades this scratch was allocated for. */
    _numCascades: number;
    /** Shared CsmCascades result object mutated in place each frame. */
    _cascades: CsmCascades;
    /** Per-cascade scratch: view matrix (16), proj matrix (16), snap matrix (16), temp multiply (16). */
    _perCascade: Float32Array;
    /** Pre-allocated subarray views into _perCascade: [cascade][0=view,1=proj,2=snap,3=temp]. */
    _perCascadeViews: Float32Array[][];
    /** Inverse view-projection matrix (16 floats). */
    _invViewProj: Float32Array;
    /** 8 frustum corners × 3 coords = 24 floats. */
    _corners: Float32Array;
    /** Pre-allocated break distance array (n floats). */
    _breakDist: number[];
    /** Pre-allocated caster world AABB min (x,y,z). */
    _aabbMin: Float64Array;
    /** Pre-allocated caster world AABB max (x,y,z). */
    _aabbMax: Float64Array;
    /** Whether the AABB is valid (at least one finite caster). */
    _aabbValid: boolean;
}

export const preloadCsmShadowTaskState = preloadPcfShadowTaskState;

/** @internal Allocate fixed-size scratch storage for zero-allocation per-frame cascade fitting. */
export function _createCascadeScratch(n: number): CsmCascadeScratch {
    const transforms: Float32Array[] = [];
    const biased: Float32Array[] = [];
    const views: Float32Array[] = [];
    for (let i = 0; i < n; i++) {
        transforms.push(new Float32Array(16));
        biased.push(new Float32Array(16));
        views.push(new Float32Array(16));
    }
    // Per-cascade scratch: view(16) + proj(16) + snap(16) + temp(16) = 64 floats per cascade
    const perCascade = new Float32Array(n * 64);
    const perCascadeViews: Float32Array[][] = [];
    for (let i = 0; i < n; i++) {
        const off = i * 64;
        perCascadeViews.push([
            perCascade.subarray(off, off + 16),       // view
            perCascade.subarray(off + 16, off + 32),  // proj
            perCascade.subarray(off + 32, off + 48),  // snap
            perCascade.subarray(off + 48, off + 64),  // temp
        ]);
    }
    return {
        _numCascades: n,
        _cascades: {
            _transforms: transforms,
            _biased: biased,
            _views: views,
            _near: new Array<number>(n).fill(0),
            _far: new Array<number>(n).fill(0),
            _viewFrustumZ: new Array<number>(n).fill(0),
            _frustumLengths: new Array<number>(n).fill(0),
        },
        _perCascade: perCascade,
        _perCascadeViews: perCascadeViews,
        _invViewProj: new Float32Array(16),
        _corners: new Float32Array(24), // 8 corners × 3 coords
        _breakDist: new Array<number>(n).fill(0),
        _aabbMin: new Float64Array(3),
        _aabbMax: new Float64Array(3),
        _aabbValid: false,
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
        _biasViewProjectionInto(cascades._biased[i]!, cascades._transforms[i]!, clipBias);
        updateShadowCameraBase(cam, state._cameraVersion, cascades._near[i]!, cascades._far[i]!, cascades._views[i]!, cascades._biased[i]!);
    }

    state._lastCasterVersion = casterVersion;
    state._lastLightVersion = lightVersion;
    state._lastCamVersion = camVersion;
    state._lastCamAspect = camAspect;
    return state._task.execute?.() ?? 0;
}

// ─── CSM math (isolated to this module) ─────────────────────────────

export interface CsmCascades {
    /** @internal Unbiased receiver transform per cascade (col-major). */
    _transforms: Float32Array[];
    /** @internal Same as _transforms, used for the caster camera before bias. */
    _biased: Float32Array[];
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

/** Transform a point by a 4×4 column-major matrix with perspective divide, writing xyz into `out` at offset `o`. */
function transformCoordInto(out: Float32Array, o: number, m: ArrayLike<number>, x: number, y: number, z: number): void {
    const X = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
    const Y = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
    const Z = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
    const W = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
    out[o] = X / W;
    out[o + 1] = Y / W;
    out[o + 2] = Z / W;
}

/** Column-major OrthoOffCenterLH with half-z NDC (z: near→0, far→1). Writes into pre-allocated buffer. */
function orthoOffCenterLHInto(m: Float32Array, l: number, r: number, b: number, t: number, n: number, f: number): void {
    m[0] = 2 / (r - l);
    m[1] = 0;
    m[2] = 0;
    m[3] = 0;
    m[4] = 0;
    m[5] = 2 / (t - b);
    m[6] = 0;
    m[7] = 0;
    m[8] = 0;
    m[9] = 0;
    m[10] = 1 / (f - n);
    m[11] = 0;
    m[12] = -(r + l) / (r - l);
    m[13] = -(t + b) / (t - b);
    m[14] = -n / (f - n);
    m[15] = 1;
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
    const breakDistValues = scratch._breakDist;
    const viewFrustumZ = cascades._viewFrustumZ;
    const frustumLengths = cascades._frustumLengths;
    for (let i = 0; i < n; i++) {
        const p = (i + 1) / n;
        const log = minZ * ratio ** p;
        const uniform = minZ + range * p;
        const d = cfg._lambda * (log - uniform) + uniform;
        breakDistValues[i] = (d - near) / cameraRange;
        viewFrustumZ[i] = d;
    }
    for (let i = 0; i < n; i++) {
        const prevBreak = i === 0 ? minDistance : breakDistValues[i - 1]!;
        frustumLengths[i] = (breakDistValues[i]! - prevBreak) * cameraRange;
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

    _castersWorldAabbInto(casterMeshes, scratch);

    for (let c = 0; c < n; c++) {
        const prevSplit = c === 0 ? 0 : breakDistValues[c - 1]!;
        const split = breakDistValues[c]!;

        // World-space frustum corners of this slice, stored flat in scratch._corners (8×3).
        for (let k = 0; k < 8; k++) {
            const ndc = FRUSTUM_NDC[k]!;
            transformCoordInto(corners, k * 3, invViewProj, ndc[0], ndc[1], ndc[2]);
        }
        // Interpolate near/far corners to cascade slice boundaries
        for (let k = 0; k < 4; k++) {
            const nOff = k * 3;
            const fOff = (k + 4) * 3;
            const rx = corners[fOff]! - corners[nOff]!;
            const ry = corners[fOff + 1]! - corners[nOff + 1]!;
            const rz = corners[fOff + 2]! - corners[nOff + 2]!;
            const nx = corners[nOff]!;
            const ny = corners[nOff + 1]!;
            const nz = corners[nOff + 2]!;
            corners[fOff] = nx + rx * split;
            corners[fOff + 1] = ny + ry * split;
            corners[fOff + 2] = nz + rz * split;
            corners[nOff] = nx + rx * prevSplit;
            corners[nOff + 1] = ny + ry * prevSplit;
            corners[nOff + 2] = nz + rz * prevSplit;
        }

        // Centroid.
        let cx = 0,
            cy = 0,
            cz = 0;
        for (let k = 0; k < 8; k++) {
            cx += corners[k * 3]!;
            cy += corners[k * 3 + 1]!;
            cz += corners[k * 3 + 2]!;
        }
        cx /= 8;
        cy /= 8;
        cz /= 8;

        let minX: number, maxX: number, minY: number, maxY: number, minEz: number, maxEz: number;
        let stableRadius = 0;

        // Pre-allocated subarray views from scratch
        const cascadeViews = scratch._perCascadeViews[c]!;
        const viewBuf = cascadeViews[0]!;
        const projBuf = cascadeViews[1]!;
        const snapBuf = cascadeViews[2]!;
        const tempBuf = cascadeViews[3]!;

        if (cfg._stabilizeCascades) {
            let radius = 0;
            for (let k = 0; k < 8; k++) {
                radius = Math.max(radius, Math.hypot(corners[k * 3]! - cx, corners[k * 3 + 1]! - cy, corners[k * 3 + 2]! - cz));
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
            for (let k = 0; k < 8; k++) {
                const px = corners[k * 3]!;
                const py = corners[k * 3 + 1]!;
                const pz = corners[k * 3 + 2]!;
                const lx = viewBuf[0]! * px + viewBuf[4]! * py + viewBuf[8]! * pz + viewBuf[12]!;
                const ly = viewBuf[1]! * px + viewBuf[5]! * py + viewBuf[9]! * pz + viewBuf[13]!;
                const lz = viewBuf[2]! * px + viewBuf[6]! * py + viewBuf[10]! * pz + viewBuf[14]!;
                minX = Math.min(minX, lx);
                maxX = Math.max(maxX, lx);
                minY = Math.min(minY, ly);
                maxY = Math.max(maxY, ly);
                minEz = Math.min(minEz, lz);
                maxEz = Math.max(maxEz, lz);
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
        if (scratch._aabbValid) {
            const aabbMin = scratch._aabbMin;
            const aabbMax = scratch._aabbMax;
            let cMinZ = Infinity;
            let cMaxZ = -Infinity;
            for (let k = 0; k < 8; k++) {
                const wx = k & 1 ? aabbMax[0]! : aabbMin[0]!;
                const wy = k & 2 ? aabbMax[1]! : aabbMin[1]!;
                const wz = k & 4 ? aabbMax[2]! : aabbMin[2]!;
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

        orthoOffCenterLHInto(projBuf, minX, maxX, minY, maxY, viewMinZ, viewMaxZ);
        const transform = cascades._transforms[c]!;
        multiply4x4Into(transform, projBuf, view);

        // Texel-snap
        let aClipX = transform[12]!;
        let aClipY = transform[13]!;
        if (cfg._stabilizeCascades && stableRadius > 0) {
            const texelWorld = (2 * stableRadius) / cfg._mapSize;
            const rX = view[0]!,
                rY = view[4]!,
                rZ = view[8]!;
            const uX = view[1]!,
                uY = view[5]!,
                uZ = view[9]!;
            const sr = Math.round((rX * cx + rY * cy + rZ * cz) / texelWorld) * texelWorld;
            const tr = Math.round((uX * cx + uY * cy + uZ * cz) / texelWorld) * texelWorld;
            const ax = sr * rX + tr * uX;
            const ay = sr * rY + tr * uY;
            const az = sr * rZ + tr * uZ;
            aClipX = transform[0]! * ax + transform[4]! * ay + transform[8]! * az + transform[12]!;
            aClipY = transform[1]! * ax + transform[5]! * ay + transform[9]! * az + transform[13]!;
        }
        const ox = aClipX * (cfg._mapSize / 2);
        const oy = aClipY * (cfg._mapSize / 2);
        const offX = (Math.round(ox) - ox) * (2 / cfg._mapSize);
        const offY = (Math.round(oy) - oy) * (2 / cfg._mapSize);
        // Build snap matrix in place
        snapBuf[0] = 1;
        snapBuf[1] = 0;
        snapBuf[2] = 0;
        snapBuf[3] = 0;
        snapBuf[4] = 0;
        snapBuf[5] = 1;
        snapBuf[6] = 0;
        snapBuf[7] = 0;
        snapBuf[8] = 0;
        snapBuf[9] = 0;
        snapBuf[10] = 1;
        snapBuf[11] = 0;
        snapBuf[12] = offX;
        snapBuf[13] = offY;
        snapBuf[14] = 0;
        snapBuf[15] = 1;
        // proj = snap * proj0
        multiply4x4Into(tempBuf, snapBuf, projBuf);
        // transform = proj * view
        multiply4x4Into(transform, tempBuf, view);

        cascades._near[c] = viewMinZ;
        cascades._far[c] = viewMaxZ;
    }

    return cascades;
}

/** Write the casters' world AABB into scratch-owned storage.  Sets `scratch._aabbValid` to indicate
 *  whether any finite caster contributed. Zero-allocation: no object/array creation. */
function _castersWorldAabbInto(casterMeshes: readonly Mesh[], scratch: CsmCascadeScratch): void {
    const aabbMin = scratch._aabbMin;
    const aabbMax = scratch._aabbMax;
    let minX = Infinity,
        minY = Infinity,
        minZ = Infinity,
        maxX = -Infinity,
        maxY = -Infinity,
        maxZ = -Infinity;
    for (let mi = 0; mi < casterMeshes.length; mi++) {
        const mesh = casterMeshes[mi]!;
        const ti = mesh.thinInstances;
        if (ti && ti.count > 0 && ti.matrices) {
            if (_thinInstanceWorldAabbInto(mesh, ti)) {
                const cache = _getThinCasterAabbCache();
                const cached = cache.get(mesh)!;
                minX = Math.min(minX, cached._minX);
                maxX = Math.max(maxX, cached._maxX);
                minY = Math.min(minY, cached._minY);
                maxY = Math.max(maxY, cached._maxY);
                minZ = Math.min(minZ, cached._minZ);
                maxZ = Math.max(maxZ, cached._maxZ);
            }
            continue;
        }
        const world = mesh.worldMatrix;
        const bmin = mesh.boundMin;
        const bmax = mesh.boundMax;
        const bminX = bmin ? bmin[0]! : -0.5;
        const bminY = bmin ? bmin[1]! : -0.5;
        const bminZ = bmin ? bmin[2]! : -0.5;
        const bmaxX = bmax ? bmax[0]! : 0.5;
        const bmaxY = bmax ? bmax[1]! : 0.5;
        const bmaxZ = bmax ? bmax[2]! : 0.5;
        for (let k = 0; k < 8; k++) {
            const lx = k & 1 ? bmaxX : bminX;
            const ly = k & 2 ? bmaxY : bminY;
            const lz = k & 4 ? bmaxZ : bminZ;
            const wx = world[0]! * lx + world[4]! * ly + world[8]! * lz + world[12]!;
            const wy = world[1]! * lx + world[5]! * ly + world[9]! * lz + world[13]!;
            const wz = world[2]! * lx + world[6]! * ly + world[10]! * lz + world[14]!;
            if (wx < minX) { minX = wx; }
            if (wx > maxX) { maxX = wx; }
            if (wy < minY) { minY = wy; }
            if (wy > maxY) { maxY = wy; }
            if (wz < minZ) { minZ = wz; }
            if (wz > maxZ) { maxZ = wz; }
        }
    }
    if (!Number.isFinite(minX)) {
        scratch._aabbValid = false;
        return;
    }
    aabbMin[0] = minX;
    aabbMin[1] = minY;
    aabbMin[2] = minZ;
    aabbMax[0] = maxX;
    aabbMax[1] = maxY;
    aabbMax[2] = maxZ;
    scratch._aabbValid = true;
}

interface ThinCasterAabbEntry {
    _version: number;
    _worldVersion: number;
    _valid: boolean;
    _minX: number; _minY: number; _minZ: number;
    _maxX: number; _maxY: number; _maxZ: number;
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

/** Compute the world AABB of a thin-instanced caster into a stable cache entry, returning validity. */
function _thinInstanceWorldAabbInto(mesh: Mesh, ti: NonNullable<Mesh["thinInstances"]>): boolean {
    const cache = _getThinCasterAabbCache();
    const worldVersion = mesh.worldMatrixVersion;
    let entry = cache.get(mesh);
    if (entry && entry._version === ti._version && entry._worldVersion === worldVersion) {
        return entry._valid;
    }
    if (!entry) {
        entry = { _version: 0, _worldVersion: 0, _valid: false, _minX: 0, _minY: 0, _minZ: 0, _maxX: 0, _maxY: 0, _maxZ: 0 };
        cache.set(mesh, entry);
    }
    // Hoist the prototype world matrix once (worldMatrix is a getter) — it is constant across all instances.
    const world = mesh.worldMatrix;
    const bmin = mesh.boundMin;
    const bmax = mesh.boundMax;
    const bminX = bmin ? bmin[0]! : -0.5;
    const bminY = bmin ? bmin[1]! : -0.5;
    const bminZ = bmin ? bmin[2]! : -0.5;
    const bmaxX = bmax ? bmax[0]! : 0.5;
    const bmaxY = bmax ? bmax[1]! : 0.5;
    const bmaxZ = bmax ? bmax[2]! : 0.5;
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
            const lx = k & 1 ? bmaxX : bminX;
            const ly = k & 2 ? bmaxY : bminY;
            const lz = k & 4 ? bmaxZ : bminZ;
            // 1) instance-local: ip = instanceMatrix * localCorner
            const ix = mats[o]! * lx + mats[o + 4]! * ly + mats[o + 8]! * lz + mats[o + 12]!;
            const iy = mats[o + 1]! * lx + mats[o + 5]! * ly + mats[o + 9]! * lz + mats[o + 13]!;
            const iz = mats[o + 2]! * lx + mats[o + 6]! * ly + mats[o + 10]! * lz + mats[o + 14]!;
            // 2) world: wp = mesh.world * ip  (matches finalWorld = mesh.world * instanceMatrix)
            const wx = world[0]! * ix + world[4]! * iy + world[8]! * iz + world[12]!;
            const wy = world[1]! * ix + world[5]! * iy + world[9]! * iz + world[13]!;
            const wz = world[2]! * ix + world[6]! * iy + world[10]! * iz + world[14]!;
            if (wx < minX) { minX = wx; }
            if (wx > maxX) { maxX = wx; }
            if (wy < minY) { minY = wy; }
            if (wy > maxY) { maxY = wy; }
            if (wz < minZ) { minZ = wz; }
            if (wz > maxZ) { maxZ = wz; }
        }
    }
    entry._version = ti._version;
    entry._worldVersion = worldVersion;
    if (!Number.isFinite(minX)) {
        entry._valid = false;
        return false;
    }
    entry._minX = minX; entry._minY = minY; entry._minZ = minZ;
    entry._maxX = maxX; entry._maxY = maxY; entry._maxZ = maxZ;
    entry._valid = true;
    return true;
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

/** @internal Apply clip-space Z bias to a view-projection matrix, writing into `out`.
 *  `src` may alias `out` safely. Zero-allocation variant of _biasViewProjection. */
export function _biasViewProjectionInto(out: Float32Array, src: Float32Array, clipOffset: number): void {
    if (out !== src) {
        out.set(src);
    }
    for (let col = 0; col < 4; col++) {
        const z = 2 + col * 4;
        const w = 3 + col * 4;
        out[z] = src[z]! + clipOffset * src[w]!;
    }
}

export function _biasViewProjection(viewProj: Float32Array, clipOffset: number): Float32Array {
    const biased = new Float32Array(viewProj);
    _biasViewProjectionInto(biased, viewProj, clipOffset);
    return biased;
}
