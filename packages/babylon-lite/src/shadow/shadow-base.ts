/**
 * Shared shadow helpers used by ESM and PCF shadow generators/tasks.
 */

import type { Camera } from "../camera/camera.js";
import type { EngineContextInternal } from "../engine/engine.js";
import type { RenderTarget } from "../engine/render-target.js";
import type { Mesh } from "../mesh/mesh.js";
import { createUniformBuffer } from "../resource/gpu-buffers.js";
import type { ShadowGenerator } from "./shadow-generator.js";

/** Write shadow generator state into a Float32Array(24) for UBO upload.
 *  Layout: [lightMatrix(16), depthValues.x, depthValues.y, 0, 0, shadowsInfo(4)] */
export function writeShadowUboFields(out: Float32Array, sg: { _lightMatrix: Float32Array; _depthValues: Float32Array; _shadowsInfo: Float32Array }): void {
    out.set(sg._lightMatrix, 0);
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
    return new Float32Array([rx, ux, fx, 0, ry, uy, fy, 0, rz, uz, fz, 0, -(rx * px + ry * py + rz * pz), -(ux * px + uy * py + uz * pz), -(fx * px + fy * py + fz * pz), 1]);
}

/** Multiply two column-major 4x4 matrices: out = a * b. */
export function multiply4x4(a: Float32Array, b: Float32Array): Float32Array {
    const out = new Float32Array(16);
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

/** Create the shared shadow-params UBO (32 bytes) holding bias/depthScale/depth-range fields. */
export function createShadowParamsUBO(engine: EngineContextInternal, bias: number, depthScale: number): GPUBuffer {
    const data = new Float32Array(8);
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
            colorFormat: colorTexture ? "rgba16float" : undefined,
            depthStencilFormat: "depth32float",
            sampleCount: 1,
            flipY: false,
        },
        _colorTexture: colorTexture,
        _colorView: colorTexture?.createView() ?? null,
        _depthTexture: depthTexture,
        _depthView: depthTexture.createView(),
        _width: mapSize,
        _height: mapSize,
        _eager: true,
    };
}

/** Create the shared receiver-side shadow UBO (96 bytes), initialised from state. */
export function createSharedShadowUBO(
    engine: EngineContextInternal,
    _lightMatrix: Float32Array,
    _depthValues: Float32Array,
    _shadowsInfo: Float32Array
): { ubo: GPUBuffer; data: Float32Array } {
    const data = new Float32Array(24);
    writeShadowUboFields(data, { _lightMatrix, _depthValues, _shadowsInfo });
    const ubo = createUniformBuffer(engine, data);
    return { ubo, data };
}

/** Sum caster world matrix versions for shadow-map dirty checks. */
export function casterVersionSum(casterMeshes: readonly Mesh[]): number {
    let sum = 0;
    for (const mesh of casterMeshes) {
        sum += mesh.worldMatrixVersion;
    }
    return sum;
}

/** Create the light-owned camera facade used by shadow render tasks. */
export function createShadowCamera(sg: Pick<ShadowGenerator, "_light">): Camera {
    return {
        fov: 1,
        nearPlane: 1,
        farPlane: 1,
        children: [],
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
