/**
 * Shared shadow helpers used by ESM and PCF shadow generators/tasks.
 */

import { F32 } from "../engine/typed-arrays.js";
import type { Camera } from "../camera/camera.js";
import type { EngineContext } from "../engine/engine.js";
import type { Mat4Storage } from "../math/types.js";
import type { RenderTarget } from "../engine/render-target.js";
import type { DirectionalLight } from "../light/directional-light.js";
import type { Mesh } from "../mesh/mesh.js";
import { createUniformBuffer } from "../resource/gpu-buffers.js";
import type { ShadowGenerator } from "./shadow-generator.js";
import { packMat4IntoF32 } from "../math/pack-mat4-into-f32.js";
import { allocateMat4 } from "../math/_matrix-allocator.js";

/** Write shadow generator state into a Float32Array(24) for UBO upload.
 *  Layout: [lightMatrix(16), depthValues.x, depthValues.y, 0, 0, shadowsInfo(4)] */
export function writeShadowUboFields(out: Float32Array, sg: { _lightMatrix: Float32Array; _depthValues: Float32Array; _shadowsInfo: Float32Array }): void {
    packMat4IntoF32(out, sg._lightMatrix, 0);
    out[16] = sg._depthValues[0]!;
    out[17] = sg._depthValues[1]!;
    out[18] = 0;
    out[19] = 0;
    out[20] = sg._shadowsInfo[0]!;
    out[21] = sg._shadowsInfo[1]!;
    out[22] = sg._shadowsInfo[2]!;
    out[23] = sg._shadowsInfo[3]!;
}

/** Build a light-space view matrix (column-major 4x4) from direction + position.
 *  Shared between directional and spot shadow generators. */
export function buildLightViewMatrix(dirX: number, dirY: number, dirZ: number, px: number, py: number, pz: number): Float32Array {
    const len = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ) || 1;
    const fx = dirX / len;
    const fy = dirY / len;
    const fz = dirZ / len;

    let upX = 0,
        upY = 1,
        upZ = 0;
    if (Math.abs(fy) > 0.99) {
        upX = 0;
        upY = 0;
        upZ = 1;
    }
    // right = cross(up, forward)
    let rx = upY * fz - upZ * fy;
    let ry = upZ * fx - upX * fz;
    let rz = upX * fy - upY * fx;
    const rLen = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1;
    rx /= rLen;
    ry /= rLen;
    rz /= rLen;

    // up = cross(forward, right)
    const ux = fy * rz - fz * ry;
    const uy = fz * rx - fx * rz;
    const uz = fx * ry - fy * rx;

    // Column-major view matrix (stores basis as rows of rotation, plus translation column)
    return new F32([rx, ux, fx, 0, ry, uy, fy, 0, rz, uz, fz, 0, -(rx * px + ry * py + rz * pz), -(ux * px + uy * py + uz * pz), -(fx * px + fy * py + fz * pz), 1]);
}

/** Multiply two column-major 4x4 matrices: out = a * b. */
export function multiply4x4(a: Float32Array, b: Float32Array): Float32Array {
    const out = new F32(16);
    for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 4; col++) {
            let sum = 0;
            for (let k = 0; k < 4; k++) {
                sum += a[row + k * 4]! * b[k + col * 4]!;
            }
            out[row + col * 4] = sum;
        }
    }
    return out;
}

/** Fit an orthographic directional-light projection to caster world-space bounds. */
export function computeDirectionalLightMatrix(
    light: DirectionalLight,
    casterMeshes: readonly Mesh[],
    orthoMinZ: number,
    orthoMaxZ: number,
    offX = 0,
    offY = 0,
    offZ = 0
): { _view: Float32Array; _viewProj: Float32Array; _near: number; _far: number } {
    const view = buildLightViewMatrix(light.direction.x, light.direction.y, light.direction.z, light.position.x - offX, light.position.y - offY, light.position.z - offZ);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const mesh of casterMeshes) {
        const world = mesh.worldMatrix;
        const boundMin = mesh.boundMin ?? [-0.5, -0.5, -0.5];
        const boundMax = mesh.boundMax ?? [0.5, 0.5, 0.5];
        for (let corner = 0; corner < 8; corner++) {
            const localX = corner & 1 ? boundMax[0] : boundMin[0];
            const localY = corner & 2 ? boundMax[1] : boundMin[1];
            const localZ = corner & 4 ? boundMax[2] : boundMin[2];
            const worldX = world[0]! * localX + world[4]! * localY + world[8]! * localZ + world[12]! - offX;
            const worldY = world[1]! * localX + world[5]! * localY + world[9]! * localZ + world[13]! - offY;
            const worldZ = world[2]! * localX + world[6]! * localY + world[10]! * localZ + world[14]! - offZ;
            const viewX = view[0]! * worldX + view[4]! * worldY + view[8]! * worldZ + view[12]!;
            const viewY = view[1]! * worldX + view[5]! * worldY + view[9]! * worldZ + view[13]!;
            minX = Math.min(minX, viewX);
            maxX = Math.max(maxX, viewX);
            minY = Math.min(minY, viewY);
            maxY = Math.max(maxY, viewY);
        }
    }
    if (!Number.isFinite(minX)) {
        minX = -1;
        maxX = 1;
        minY = -1;
        maxY = 1;
    }
    const padX = (maxX - minX) * 0.1;
    const padY = (maxY - minY) * 0.1;
    minX -= padX;
    maxX += padX;
    minY -= padY;
    maxY += padY;

    const projection = new F32(16);
    projection[0] = 2 / (maxX - minX);
    projection[5] = 2 / (maxY - minY);
    projection[10] = 1 / (orthoMaxZ - orthoMinZ);
    projection[12] = -(maxX + minX) / (maxX - minX);
    projection[13] = -(maxY + minY) / (maxY - minY);
    projection[14] = -orthoMinZ / (orthoMaxZ - orthoMinZ);
    projection[15] = 1;
    return { _view: view, _viewProj: multiply4x4(projection, view), _near: orthoMinZ, _far: orthoMaxZ };
}

/** Create the shared shadow-params UBO (32 bytes) holding bias/depthScale/depth-range fields. */
export function createShadowParamsUBO(engine: EngineContext, bias: number, depthScale: number): GPUBuffer {
    const data = new F32(8);
    data[0] = bias;
    data[2] = depthScale;
    data[4] = 0; // depthMinZ (WebGPU)
    data[5] = 1; // depthMinZ + depthMaxZ
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
            _depthClearValue: 1,
            _depthCompare: "less-equal",
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
            return state ?? sg._light.worldMatrixVersion;
        },
    } as Camera;
}

/** Update the camera facade caches shared by all shadow task variants. */
export function updateShadowCameraBase(camera: Camera, cameraVersion: number, near: number, far: number, view: Float32Array, viewProj: Float32Array): void {
    camera.nearPlane = near;
    camera.farPlane = far;
    camera._viewCache = view;
    camera._viewVer = cameraVersion;
    camera._vpCache = viewProj;
    camera._vpVer = cameraVersion;
    camera._vpAspect = 1;
    (camera as Camera & { _shadowCameraVersion?: number })._shadowCameraVersion = cameraVersion;
}
