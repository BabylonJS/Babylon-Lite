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
import { createRenderTask, type RenderTask } from "../frame-graph/render-task.js";
import { getViewProjectionMatrix } from "../camera/camera.js";
import { mat4Invert } from "../math/mat4-invert.js";
import { buildLightViewMatrix, casterVersionSum, createShadowCamera, multiply4x4, updateShadowCameraBase } from "./shadow-base.js";
import { getNoColorView, preloadPcfShadowTaskState } from "./pcf-shadow-task-hooks.js";
import type { ShadowGenerator, ShadowTaskInternalState } from "./shadow-generator.js";

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
     *  it changes — not only when the caster SET changes. */
    _renderableVersion: number;
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
        // The caster set OR a material changed (a material swap rebuilds a caster's renderable + UBOs but
        // leaves our cached no-color material views dangling at the destroyed UBOs — this is the
        // "Buffer used in submit while destroyed" flood seen when planting a shadow-casting fern/agave,
        // whose foliage material swaps variant on first render). Rebuild the cascade tasks below with the
        // casters' CURRENT materials and return the NEW state — the caller swaps to it, so the OLD task is
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
        if (cfg._stabilizeCascades) {
            let radius = 0;
            for (const p of corners) {
                radius = Math.max(radius, Math.hypot(p[0] - cx, p[1] - cy, p[2] - cz));
            }
            radius = Math.ceil(radius * 16) / 16;
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
        }

        const proj0 = orthoOffCenterLH(minX, maxX, minY, maxY, viewMinZ, viewMaxZ);
        let transform = multiply4x4(proj0, view);

        // Texel-snap: round the world origin to a shadow-map texel (always applied in BJS).
        const ox = transform[12]! * (cfg._mapSize / 2);
        const oy = transform[13]! * (cfg._mapSize / 2);
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
