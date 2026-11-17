/**
 * Shared shadow helpers used by ESM and PCF shadow generators/tasks.
 */

import { F32 } from "../engine/typed-arrays.js";
import { _rightHanded } from "#coordinate-system";
import type { Camera } from "../camera/camera.js";
import { _cameraChangeKey } from "../camera/camera.js";
import type { EngineContext } from "../engine/engine.js";
import type { Mat4Storage } from "../math/types.js";
import type { RenderTarget } from "../engine/render-target.js";
import type { DirectionalLight } from "../light/directional-light.js";
import type { SpotLight } from "../light/spot-light.js";
import type { Mesh } from "../mesh/mesh.js";
import { createUniformBuffer } from "../resource/uniform-buffer.js";
import type { ShadowGenerator } from "./shadow-generator.js";
import { allocateMat4 } from "../math/_matrix-allocator.js";
import type { getDirectionalShadowCaster } from "./thin-instance-shadow-bounds.js";
import { _preloadRegisteredShadowCasters } from "../frame-graph/shadow-inputs.js";
import { multiplyMat4IntoBuffer } from "../math/multiply-mat4-into-buffer.js";

let directionalShadowCaster: typeof getDirectionalShadowCaster | undefined;

function hasThinInstances(mesh: Mesh): boolean {
    return !!mesh.thinInstances;
}

/** Load instance-bound computation only for directional tasks with instanced casters. */
export async function preloadDirectionalShadowBounds(casterMeshes: readonly Mesh[]): Promise<void> {
    if (!directionalShadowCaster && casterMeshes.some(hasThinInstances)) {
        directionalShadowCaster = (await import("./thin-instance-shadow-bounds.js")).getDirectionalShadowCaster;
    }
}

/** Reuse the task's preload gate when an existing caster becomes thin-instanced. */
export function prepareDirectionalShadowBounds(generator: ShadowGenerator, casterMeshes: readonly Mesh[]): boolean {
    if (!directionalShadowCaster && casterMeshes.some(hasThinInstances)) {
        _preloadRegisteredShadowCasters(generator);
        return false;
    }
    return true;
}

/** Write shadow generator state into a Float32Array(24) for UBO upload.
 *  Layout: [lightMatrix(16), depthValues.x, depthValues.y, 0, 0, shadowsInfo(4)] */
export function writeShadowUboFields(out: Float32Array, sg: { _lightMatrix: Float32Array; _depthValues: Float32Array; _shadowsInfo: Float32Array }): void {
    out.set(sg._lightMatrix);
    out.set(sg._depthValues, 16);
    out.fill(0, 18, 20);
    out.set(sg._shadowsInfo, 20);
}

/** Build a light-space view matrix (column-major 4x4) from direction + position.
 *  Shared between directional and spot shadow generators. */
export function buildLightViewMatrix(dirX: number, dirY: number, dirZ: number, px: number, py: number, pz: number): Float32Array {
    const len = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ) || 1;
    const fx = dirX / len;
    const fy = dirY / len;
    const fz = dirZ / len;

    // right = cross(up, forward), with Z-up only for near-vertical directions.
    const vertical = Math.abs(fy) > 0.99;
    const upY = vertical ? 0 : 1;
    const upZ = vertical ? 1 : 0;
    let rx = upY * fz - upZ * fy;
    let ry = upZ * fx - 0 * fz;
    let rz = 0 * fy - upY * fx;
    const rLen = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1;
    rx /= rLen;
    ry /= rLen;
    rz /= rLen;

    // up = cross(forward, right)
    const ux = fy * rz - fz * ry;
    const uy = fz * rx - fx * rz;
    const uz = fx * ry - fy * rx;
    if (_rightHanded !== null) {
        // Right-handed: mirror the light's X axis. The shadow pass then mirrors like the camera pass, so the
        // camera pass's flipped `frontFace` culls the same faces as Babylon.js's left-handed light pass.
        rx = -rx;
        ry = -ry;
        rz = -rz;
    }

    // Column-major view matrix (stores basis as rows of rotation, plus translation column)
    return new F32([rx, ux, fx, 0, ry, uy, fy, 0, rz, uz, fz, 0, -(rx * px + ry * py + rz * pz), -(ux * px + uy * py + uz * pz), -(fx * px + fy * py + fz * pz), 1]);
}

/** Shared node-to-light-view conversion for directional and spot shadow fits. */
export function getShadowLightView(light: DirectionalLight | SpotLight, offX: number, offY: number, offZ: number): Float32Array {
    const world = light.worldMatrix;
    const { x, y, z } = light.direction;
    const dx = world[0]! * x + world[4]! * y + world[8]! * z;
    const dy = world[1]! * x + world[5]! * y + world[9]! * z;
    const dz = world[2]! * x + world[6]! * y + world[10]! * z;
    return buildLightViewMatrix(dx, dy, dz, world[12]! - offX, world[13]! - offY, world[14]! - offZ);
}

/** Multiply two column-major 4x4 matrices: out = a * b. */
export function multiply4x4(a: Float32Array, b: Float32Array): Float32Array {
    const out = new F32(16);
    multiplyMat4IntoBuffer(out, 0, a, 0, b, 0);
    return out;
}

/** Fit an orthographic directional-light projection. Callers prepare thin-instance bounds before fitting. */
export function computeDirectionalLightMatrix(
    light: DirectionalLight,
    casterMeshes: readonly Mesh[],
    orthoMinZ: number,
    orthoMaxZ: number,
    offX = 0,
    offY = 0,
    offZ = 0
): { _view: Float32Array; _viewProj: Float32Array; _near: number; _far: number } {
    const view = getShadowLightView(light, offX, offY, offZ);
    const viewProj = new F32(view);
    for (let axis = 0; axis < 3; axis++) {
        const depthRow = axis === 2;
        let min = orthoMinZ;
        let max = orthoMaxZ;
        if (!depthRow) {
            min = Infinity;
            max = -Infinity;
            for (const mesh of casterMeshes) {
                const caster = directionalShadowCaster ? directionalShadowCaster(mesh) : mesh;
                if (!caster) {
                    continue;
                }
                const world = caster.worldMatrix;
                const boundMin = caster.boundMin ?? [-0.5, -0.5, -0.5];
                const boundMax = caster.boundMax ?? [0.5, 0.5, 0.5];
                // Project box intervals through the composed affine transform, not eight separate corners.
                let lower = view[axis]! * (world[12]! - offX) + view[4 + axis]! * (world[13]! - offY) + view[8 + axis]! * (world[14]! - offZ) + view[12 + axis]!;
                let upper = lower;
                for (let column = 0; column < 3; column++) {
                    let coefficient = 0;
                    for (let inner = 0; inner < 3; inner++) {
                        coefficient += view[inner * 4 + axis]! * world[column * 4 + inner]!;
                    }
                    const a = coefficient * boundMin[column]!;
                    const b = coefficient * boundMax[column]!;
                    lower += Math.min(a, b);
                    upper += Math.max(a, b);
                }
                min = Math.min(min, lower);
                max = Math.max(max, upper);
            }
            if (!Number.isFinite(min)) {
                min = -1;
                max = 1;
            }
        }
        // X/Y retain ten percent padding on both sides; Z retains the configured depth range.
        const span = (max - min) * (depthRow ? 1 : 1.2);
        const scale = (depthRow ? 1 : 2) / span;
        const offset = -(depthRow ? min : max + min) / span;
        for (let column = 0; column < 16; column += 4) {
            viewProj[column + axis] = view[column + axis]! * scale + view[column + 3]! * offset;
        }
    }
    return { _view: view, _viewProj: viewProj, _near: orthoMinZ, _far: orthoMaxZ };
}

/** Create the shared shadow-params UBO (32 bytes) holding bias/depthScale/depth-range fields. */
export function createShadowParamsUBO(engine: EngineContext, bias: number, depthScale: number): GPUBuffer {
    const data = new F32([bias, 0, depthScale, 0, 0, 1, 0, 0]);
    return createUniformBuffer(engine, data);
}

/** Create the eager shadow-map render target used by frame-graph shadow tasks. */
export function createShadowRenderTarget(sg: ShadowGenerator, colorTexture: GPUTexture | null = null, depthTexture: GPUTexture = sg._depthTexture): RenderTarget {
    const mapSize = sg._config._mapSize;
    return {
        _descriptor: {
            size: { width: mapSize, height: mapSize },
            format: colorTexture ? "rgba16float" : undefined,
            dFormat: "depth32float",
            depthClearValue: 1,
            depthCompare: "less-equal",
            samples: 1,
        },
        _colorTexture: colorTexture,
        _colorView: colorTexture?.createView() ?? null,
        _depthTexture: depthTexture,
        _depthView: depthTexture.createView(),
        _width: mapSize,
        _height: mapSize,
        _eager: true,
        // Borrowed: the depth map is the generator's shared shadow map (persists for the generator's
        // lifetime); per-task render-target disposal must NOT destroy it (it's reused after rebuilds).
        _ownsDepthTexture: false,
    };
}

/** Create the shared receiver-side shadow UBO (96 bytes), initialised from state. */
export function createSharedShadowUBO(
    engine: EngineContext,
    _lightMatrix: Float32Array,
    _depthValues: Float32Array,
    _shadowsInfo: Float32Array
): { ubo: GPUBuffer; data: Float32Array } {
    const data = new F32(24);
    writeShadowUboFields(data, { _lightMatrix, _depthValues, _shadowsInfo });
    const ubo = createUniformBuffer(engine, data);
    return { ubo, data };
}

/** Sum caster transform versions plus non-transform geometry/count mutations. */
export function casterVersionSum(casterMeshes: readonly Mesh[]): number {
    let sum = 0;
    for (const mesh of casterMeshes) {
        // Bitwise coercion maps the absent optional version to zero without another branch.
        sum += mesh.worldMatrixVersion + ~~(mesh.thinInstances?._version as number);
    }
    return sum;
}

/** Create the light-owned camera facade used by shadow render tasks.
 *  Caches are pre-allocated from the process-global allocator. */
export function createShadowCamera(sg: Pick<ShadowGenerator, "_light">): Camera {
    return {
        fov: 1,
        nearPlane: 1,
        farPlane: 1,
        children: [],
        _viewCache: allocateMat4() as unknown as Mat4Storage,
        _projCache: allocateMat4() as unknown as Mat4Storage,
        _vpCache: allocateMat4() as unknown as Mat4Storage,
        get worldMatrix() {
            return sg._light.worldMatrix;
        },
        get worldMatrixVersion() {
            const state = (this as Camera & { _shadowCameraVersion?: number })._shadowCameraVersion;
            return state ?? sg._light._lightVersion;
        },
    } as Camera;
}

/** Update the camera facade caches shared by all shadow task variants.
 *
 *  This facade does not *compute* its matrices through `camera.ts` — the shadow task already
 *  built the light's view / view-projection (an orthographic or spot volume that
 *  `getProjectionMatrix` knows nothing about) and installs them here, pinning the cache
 *  versions so `getViewMatrix` / `getViewProjectionMatrix` hand them straight back.
 *
 *  The pin must therefore use the *same* key each getter compares against, or the getter
 *  misses and silently rebuilds a perspective projection over the light's volume. The view
 *  matrix keys on `worldMatrixVersion` (which the facade reports as `cameraVersion`); the
 *  view-projection keys on `_cameraChangeKey`, which additionally folds in the projection
 *  revision — and writing `nearPlane` / `farPlane` above moves that revision, so the key is
 *  read *after* those writes and after `_shadowCameraVersion` is set. */
export function updateShadowCameraBase(camera: Camera, cameraVersion: number, near: number, far: number, view: Float32Array, viewProj: Float32Array): void {
    camera.nearPlane = near;
    camera.farPlane = far;
    (camera as Camera & { _shadowCameraVersion?: number })._shadowCameraVersion = cameraVersion;
    camera._viewCache = view;
    camera._viewVer = cameraVersion;
    camera._vpCache = viewProj;
    camera._vpVer = _cameraChangeKey(camera);
    camera._vpAspect = 1;
}
