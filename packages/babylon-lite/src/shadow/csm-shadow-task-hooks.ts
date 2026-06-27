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
import { getViewProjectionMatrix } from "../camera/camera.js";
import { mat4Invert } from "../math/mat4-invert.js";
import { buildLightViewMatrix, casterVersionSum, createShadowCamera, multiply4x4, updateShadowCameraBase } from "./shadow-base.js";
import { getNoColorView, preloadPcfShadowTaskState } from "./pcf-shadow-task-hooks.js";
import type { ShadowGenerator, ShadowTaskInternalState } from "./shadow-generator.js";

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
    _depthClamp: boolean;
    /** @internal */
    _shadowMaxZ: number | null;
    /** @internal */
    _bias: number;
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
}

export const preloadCsmShadowTaskState = preloadPcfShadowTaskState;

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
            const prevSet = new Set(existing._casterMeshes);
            const nextSet = new Set(casterMeshes);
            const views = existing._materialViews;
            const gens = existing._casterMatGens;
            for (const m of existing._casterMeshes) {
                if (!nextSet.has(m)) {
                    for (const t of existing._tasks) {
                        removeMeshFromTask(t, m);
                    }
                }
            }
            for (const m of casterMeshes) {
                if (!prevSet.has(m) && m.material) {
                    const view = getNoColorView(m.material, views);
                    for (const t of existing._tasks) {
                        t.addMesh(m, { material: view });
                    }
                    gens.set(m.material, effectiveCasterGen(m.material));
                }
            }
            // Force each cascade to re-resolve its newly-added pending casters + re-bucket its binding lists.
            for (const t of existing._tasks) {
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
        // state — the caller swaps to it, so the OLD task is
        // never recorded again. Its GPU buffers may still be referenced by a frame already submitted this
        // tick, so we must NOT dispose it synchronously; defer until the GPU drains the currently-submitted
        // work (onSubmittedWorkDone). Mirrors resizeMeshGeometry.
        const old = existing._task;
        void engine._device.queue
            .onSubmittedWorkDone()
            .then(() => {
                try {
                    old.dispose();
                } catch {
                    // Device may have been lost/disposed before the deferred dispose ran — nothing to free.
                }
            })
            .catch(() => {});
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
        const task = createRenderTask({ name: `csm${i}`, rt, clr: true, cam: camera }, engine, scene);
        for (const mesh of casterMeshes) {
            const material = mesh.material;
            if (material) {
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
    for (const m of casterMeshes) {
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
        _uboData: new Float32Array(80),
        _casterMeshes: casterMeshes,
        _renderableVersion: scene._renderableVersion,
        _materialEpoch: scene._materialEpoch,
        _materialViews: materialViews,
        _casterMatGens: casterMatGens,
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
    const camVersion = camera.worldMatrixVersion;
    if (!cfg._forceRefreshEveryFrame && casterVersion === state._lastCasterVersion && lightVersion === state._lastLightVersion && camVersion === state._lastCamVersion) {
        return 0;
    }

    const cascades = _computeCsmCascades(engine, camera, sg._light as DirectionalLight, cfg, casterMeshes);

    _writeCsmUbo(state._uboData, cascades, cfg);
    sg._version++;
    engine._device.queue.writeBuffer(sg._shadowUBO, 0, state._uboData as Float32Array<ArrayBuffer>);

    // Notify custom receivers (e.g. a ShaderMaterial that mirrors the cascade transforms into
    // its own uniforms) with this frame's freshly-computed receiver UBO. This fires inside the
    // shadow task — after the transforms are finalized but before the shadow map and main pass
    // render — so such receivers stay in lock-step with the depth map. Syncing from a
    // `onBeforeRender` callback instead would read the previous frame's transforms (a one-frame
    // lag that makes those shadows swim while the camera moves). The built-in standard/PBR/node
    // receivers don't need this: they bind `sg._shadowUBO` directly.
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
        updateShadowCameraBase(cam, state._cameraVersion, cascades._near[i]!, cascades._far[i]!, cascades._views[i]!, _biasViewProjection(cascades._biased[i]!, cfg._bias));
    }

    state._lastCasterVersion = casterVersion;
    state._lastLightVersion = lightVersion;
    state._lastCamVersion = camVersion;
    return state._task.execute?.() ?? 0;
}

// ─── CSM math (isolated to this module) ─────────────────────────────

interface CsmCascades {
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

function transformCoord(m: ArrayLike<number>, x: number, y: number, z: number): [number, number, number] {
    const X = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
    const Y = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
    const Z = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
    const W = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
    return [X / W, Y / W, Z / W];
}

/** Column-major OrthoOffCenterLH with half-z NDC (z: near→0, far→1). */
function orthoOffCenterLH(l: number, r: number, b: number, t: number, n: number, f: number): Float32Array {
    const m = new Float32Array(16);
    m[0] = 2 / (r - l);
    m[5] = 2 / (t - b);
    m[10] = 1 / (f - n);
    m[12] = -(r + l) / (r - l);
    m[13] = -(t + b) / (t - b);
    m[14] = -n / (f - n);
    m[15] = 1;
    return m;
}

function _computeCsmCascades(engine: EngineContext, camera: Camera, light: DirectionalLight, cfg: CsmConfig, casterMeshes: readonly Mesh[]): CsmCascades {
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

    const breakDist: number[] = [];
    const viewFrustumZ: number[] = [];
    const frustumLengths: number[] = [];
    for (let i = 0; i < n; i++) {
        const p = (i + 1) / n;
        const log = minZ * ratio ** p;
        const uniform = minZ + range * p;
        const d = cfg._lambda * (log - uniform) + uniform;
        const prevBreak = i === 0 ? minDistance : breakDist[i - 1]!;
        breakDist[i] = (d - near) / cameraRange;
        viewFrustumZ[i] = d;
        frustumLengths[i] = (breakDist[i]! - prevBreak) * cameraRange;
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

    const aspect = engine.canvas.width / engine.canvas.height;
    const vp = getViewProjectionMatrix(camera, aspect) as unknown as ArrayLike<number>;
    const inv = mat4Invert(vp as never);
    const invViewProj: ArrayLike<number> = (inv as unknown as ArrayLike<number>) ?? vp;

    const aabb = _castersWorldAabb(casterMeshes);

    const transforms: Float32Array[] = [];
    const views: Float32Array[] = [];
    const nearOut: number[] = [];
    const farOut: number[] = [];

    for (let c = 0; c < n; c++) {
        const prevSplit = c === 0 ? 0 : breakDist[c - 1]!;
        const split = breakDist[c]!;

        // World-space frustum corners of this slice.
        const corners: [number, number, number][] = [];
        for (let k = 0; k < 8; k++) {
            const ndc = FRUSTUM_NDC[k]!;
            corners.push(transformCoord(invViewProj, ndc[0], ndc[1], ndc[2]));
        }
        for (let k = 0; k < 4; k++) {
            const nearC = corners[k]!;
            const farC = corners[k + 4]!;
            const rx = farC[0] - nearC[0];
            const ry = farC[1] - nearC[1];
            const rz = farC[2] - nearC[2];
            corners[k + 4] = [nearC[0] + rx * split, nearC[1] + ry * split, nearC[2] + rz * split];
            corners[k] = [nearC[0] + rx * prevSplit, nearC[1] + ry * prevSplit, nearC[2] + rz * prevSplit];
        }

        // Centroid.
        let cx = 0,
            cy = 0,
            cz = 0;
        for (const p of corners) {
            cx += p[0];
            cy += p[1];
            cz += p[2];
        }
        cx /= 8;
        cy /= 8;
        cz /= 8;

        let minX: number, maxX: number, minY: number, maxY: number, minEz: number, maxEz: number;
        let stableRadius = 0;
        if (cfg._stabilizeCascades) {
            let radius = 0;
            for (const p of corners) {
                radius = Math.max(radius, Math.hypot(p[0] - cx, p[1] - cy, p[2] - cz));
            }
            radius = Math.ceil(radius * 16) / 16;
            stableRadius = radius;
            minX = minY = minEz = -radius;
            maxX = maxY = maxEz = radius;
        } else {
            // Temp light view centred on the centroid to fit a tight AABB.
            const tmpView = buildLightViewMatrix(dx, dy, dz, cx, cy, cz);
            minX = minY = minEz = Infinity;
            maxX = maxY = maxEz = -Infinity;
            for (const p of corners) {
                const lp = transformCoord(tmpView, p[0], p[1], p[2]);
                minX = Math.min(minX, lp[0]);
                maxX = Math.max(maxX, lp[0]);
                minY = Math.min(minY, lp[1]);
                maxY = Math.max(maxY, lp[1]);
                minEz = Math.min(minEz, lp[2]);
                maxEz = Math.max(maxEz, lp[2]);
            }
        }

        // Shadow camera sits behind the slice along the light direction.
        const eyeX = cx + dx * minEz;
        const eyeY = cy + dy * minEz;
        const eyeZ = cz + dz * minEz;
        const view = buildLightViewMatrix(dx, dy, dz, eyeX, eyeY, eyeZ);

        let viewMinZ = 0;
        let viewMaxZ = maxEz - minEz;

        // Tighten Z to the caster bounding box in cascade view space (depthClamp = false behaviour:
        // keep all casters inside the frustum so no GPU depth-clip feature is required).
        if (aabb) {
            let cMinZ = Infinity;
            let cMaxZ = -Infinity;
            for (let k = 0; k < 8; k++) {
                const wx = k & 1 ? aabb._max[0] : aabb._min[0];
                const wy = k & 2 ? aabb._max[1] : aabb._min[1];
                const wz = k & 4 ? aabb._max[2] : aabb._min[2];
                const lz = view[2]! * wx + view[6]! * wy + view[10]! * wz + view[14]!;
                cMinZ = Math.min(cMinZ, lz);
                cMaxZ = Math.max(cMaxZ, lz);
            }
            if (cMinZ <= viewMaxZ) {
                viewMinZ = Math.min(viewMinZ, cMinZ);
                viewMaxZ = Math.min(viewMaxZ, cMaxZ);
            }

            // Z is intentionally NOT quantized here. The caster-AABB fit (cMinZ/cMaxZ) is C0-continuous in the
            // light direction — each is a min/max of linear functions of the light vector, so it has kinks but no
            // jumps — meaning the near/far drift SMOOTHLY as the light rotates. A constant NDC depth bias maps to a
            // WORLD bias of bias·(far−near), and the stored depths are likewise normalised by (far−near); the old
            // `zq = max(0.5, radius/128)` floor/ceil snapped that range to a grid, so both the effective bias AND
            // the stored depth STEPPED at each quantum boundary as the light direction changed — appearing as
            // self-shadow acne that VIBRATES. Removing the quantize makes those steps a sub-millimetre, imperceptible
            // drift, and still covers the moving-caster case it was added for (the range drifts, it never pops).
        }

        const proj0 = orthoOffCenterLH(minX, maxX, minY, maxY, viewMinZ, viewMaxZ);
        let transform = multiply4x4(proj0, view);

        // Texel-snap: lock the shadow grid to world space so it does not crawl as the camera moves, by rounding a
        // fixed WORLD anchor onto the shadow-map texel grid. BJS anchors the WORLD ORIGIN. With a STILL camera and
        // a slowly ROTATING light that is the cause of the visible "vibration": the eye is recentred on the cascade
        // centre every frame, so the snap residual is the anchor's offset from the centre measured along the light
        // axes — and the world origin's offset from the centre is large (≈ the cascade's distance from origin), so
        // its projection sweeps many texels per degree of light rotation and Math.round trips a full-texel correction
        // again and again → the whole map pops/boils. We instead anchor the world-grid point NEAREST the cascade
        // centre (cell = one texel in world units): it is still a fixed world point (a translating camera only ever
        // sees whole-cell anchor switches, ≤ a sub-texel grid wiggle that PCF hides), but its offset from the centre
        // is < 1 texel, so a full light rotation sweeps it < 1 texel → effectively no rotation pop. Non-stabilized
        // path keeps the origin anchor (no stableRadius → no texel-world size to build the world grid from).
        let aClipX = transform[12]!;
        let aClipY = transform[13]!;
        if (cfg._stabilizeCascades && stableRadius > 0) {
            const texelWorld = (2 * stableRadius) / cfg._mapSize;
            const ax = Math.round(cx / texelWorld) * texelWorld;
            const ay = Math.round(cy / texelWorld) * texelWorld;
            const az = Math.round(cz / texelWorld) * texelWorld;
            aClipX = transform[0]! * ax + transform[4]! * ay + transform[8]! * az + transform[12]!;
            aClipY = transform[1]! * ax + transform[5]! * ay + transform[9]! * az + transform[13]!;
        }
        const ox = aClipX * (cfg._mapSize / 2);
        const oy = aClipY * (cfg._mapSize / 2);
        const offX = (Math.round(ox) - ox) * (2 / cfg._mapSize);
        const offY = (Math.round(oy) - oy) * (2 / cfg._mapSize);
        const snap = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, offX, offY, 0, 1]);
        const proj = multiply4x4(snap, proj0);
        transform = multiply4x4(proj, view);

        transforms.push(transform);
        views.push(view);
        nearOut.push(viewMinZ);
        farOut.push(viewMaxZ);
    }

    return {
        _transforms: transforms,
        _biased: transforms.map((t) => new Float32Array(t)),
        _views: views,
        _near: nearOut,
        _far: farOut,
        _viewFrustumZ: viewFrustumZ,
        _frustumLengths: frustumLengths,
    };
}

function _castersWorldAabb(casterMeshes: readonly Mesh[]): { _min: [number, number, number]; _max: [number, number, number] } | null {
    let minX = Infinity,
        minY = Infinity,
        minZ = Infinity,
        maxX = -Infinity,
        maxY = -Infinity,
        maxZ = -Infinity;
    for (const mesh of casterMeshes) {
        // Thin-instanced casters are drawn at `finalWorld = mesh.world * instanceMatrix` (see
        // thin-instance-fragment.ts), so a single `mesh.worldMatrix × boundMin/Max` box ignores the per-instance
        // spread entirely — one prototype-sized box wrecks the cascade Z-fit (an off-world herd collapsed every
        // shadow). Bound the caster by the union of every drawn instance instead, using the SAME composition the
        // shader uses.
        const ti = mesh.thinInstances;
        if (ti && ti.count > 0 && ti.matrices) {
            const a = _thinInstanceWorldAabb(mesh, ti);
            if (a) {
                minX = Math.min(minX, a._min[0]);
                maxX = Math.max(maxX, a._max[0]);
                minY = Math.min(minY, a._min[1]);
                maxY = Math.max(maxY, a._max[1]);
                minZ = Math.min(minZ, a._min[2]);
                maxZ = Math.max(maxZ, a._max[2]);
            }
            continue;
        }
        const world = mesh.worldMatrix;
        const bmin = mesh.boundMin ?? [-0.5, -0.5, -0.5];
        const bmax = mesh.boundMax ?? [0.5, 0.5, 0.5];
        for (let k = 0; k < 8; k++) {
            const lx = k & 1 ? bmax[0]! : bmin[0]!;
            const ly = k & 2 ? bmax[1]! : bmin[1]!;
            const lz = k & 4 ? bmax[2]! : bmin[2]!;
            const wx = world[0]! * lx + world[4]! * ly + world[8]! * lz + world[12]!;
            const wy = world[1]! * lx + world[5]! * ly + world[9]! * lz + world[13]!;
            const wz = world[2]! * lx + world[6]! * ly + world[10]! * lz + world[14]!;
            minX = Math.min(minX, wx);
            maxX = Math.max(maxX, wx);
            minY = Math.min(minY, wy);
            maxY = Math.max(maxY, wy);
            minZ = Math.min(minZ, wz);
            maxZ = Math.max(maxZ, wz);
        }
    }
    if (!Number.isFinite(minX)) {
        return null;
    }
    return { _min: [minX, minY, minZ], _max: [maxX, maxY, maxZ] };
}

interface ThinCasterAabb {
    _min: [number, number, number];
    _max: [number, number, number];
}

/** Per-mesh cache of a thin-instanced caster's world AABB, keyed on BOTH the instance-matrix version and the
 *  prototype mesh's `worldMatrixVersion` — the drawn world transform is `mesh.world * instanceMatrix`, so the
 *  AABB must invalidate when EITHER changes (a rebake, or the prototype moving/reparenting). Lazily allocated
 *  so this module keeps zero import-time side effects and stays tree-shakable. */
let _thinCasterAabbCache: WeakMap<Mesh, { _version: number; _worldVersion: number; _aabb: ThinCasterAabb | null }> | null = null;
function _getThinCasterAabbCache(): WeakMap<Mesh, { _version: number; _worldVersion: number; _aabb: ThinCasterAabb | null }> {
    if (!_thinCasterAabbCache) {
        _thinCasterAabbCache = new WeakMap();
    }
    return _thinCasterAabbCache;
}

/** World AABB of a thin-instanced caster. Matches the shader's `finalWorld = mesh.world * instanceMatrix`
 *  exactly: each local bound corner is transformed by the per-instance matrix, then by the prototype mesh
 *  world matrix. Parked/degenerate instances (zero linear part — drawn as zero-area, used to hide an unused
 *  tail) are skipped so a tail parked far off-world can't balloon the box. */
function _thinInstanceWorldAabb(mesh: Mesh, ti: NonNullable<Mesh["thinInstances"]>): ThinCasterAabb | null {
    const cache = _getThinCasterAabbCache();
    // The drawn transform is `mesh.world * instanceMatrix`, so the AABB depends on BOTH the instance matrices
    // and the prototype world matrix — invalidate when either version changes.
    const worldVersion = mesh.worldMatrixVersion;
    const cached = cache.get(mesh);
    if (cached && cached._version === ti._version && cached._worldVersion === worldVersion) {
        return cached._aabb;
    }
    // Hoist the prototype world matrix once (worldMatrix is a getter) — it is constant across all instances.
    const world = mesh.worldMatrix;
    const bmin = mesh.boundMin ?? [-0.5, -0.5, -0.5];
    const bmax = mesh.boundMax ?? [0.5, 0.5, 0.5];
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
            if (wx < minX) {
                minX = wx;
            }
            if (wx > maxX) {
                maxX = wx;
            }
            if (wy < minY) {
                minY = wy;
            }
            if (wy > maxY) {
                maxY = wy;
            }
            if (wz < minZ) {
                minZ = wz;
            }
            if (wz > maxZ) {
                maxZ = wz;
            }
        }
    }
    const aabb: ThinCasterAabb | null = Number.isFinite(minX) ? { _min: [minX, minY, minZ], _max: [maxX, maxY, maxZ] } : null;
    cache.set(mesh, { _version: ti._version, _worldVersion: worldVersion, _aabb: aabb });
    return aabb;
}

function _writeCsmUbo(out: Float32Array, cascades: CsmCascades, cfg: CsmConfig): void {
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

function _biasViewProjection(viewProj: Float32Array, bias: number): Float32Array {
    const biased = new Float32Array(viewProj);
    const b = bias * 0.5;
    for (let col = 0; col < 4; col++) {
        const z = 2 + col * 4;
        const w = 3 + col * 4;
        biased[z] = biased[z]! + b * biased[w]!;
    }
    return biased;
}
