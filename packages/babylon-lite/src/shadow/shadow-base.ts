/**
 * Shared shadow-caster infrastructure used by both the ESM and PCF shadow generators.
 *
 * Centralises:
 *   - ShadowCaster type (per-mesh GPU state for shadow depth passes)
 *   - buildCasters()         — create caster list with UBOs + bind groups
 *   - syncCasterMatrices()   — push dirty world matrices to the GPU
 *   - drawCasters()          — issue indexed draw calls for each caster
 */

import type { Mesh } from "../mesh/mesh.js";
import type { MeshInternal } from "../mesh/mesh.js";
import type { EngineContextInternal } from "../engine/engine.js";
import { createUniformBuffer } from "../resource/gpu-buffers.js";
import { createSingleUniformBGL } from "../shader/bgl-helpers.js";

export interface ShadowCaster {
    positionBuffer: GPUBuffer;
    indexBuffer: GPUBuffer;
    indexCount: number;
    worldMatrix: Float32Array;
    meshUBO: GPUBuffer;
    bindGroup: GPUBindGroup;
    _mesh: Mesh;
    _lastWorldVersion: number;
}

/** Build caster list from meshes, creating per-caster UBOs and bind groups. */
export function buildCasters(engine: EngineContextInternal, meshes: Mesh[], meshBGL: GPUBindGroupLayout, extraEntries?: GPUBindGroupEntry[]): ShadowCaster[] {
    const device = engine.device;
    return meshes.map((mesh) => {
        const gpu = (mesh as MeshInternal)._gpu;
        const worldMatrix = new Float32Array(mesh.worldMatrix);

        const meshUBO = createUniformBuffer(engine, worldMatrix as Float32Array<ArrayBuffer>);

        const entries: GPUBindGroupEntry[] = [{ binding: 0, resource: { buffer: meshUBO } }, ...(extraEntries ?? [])];
        const bindGroup = device.createBindGroup({ layout: meshBGL, entries });

        return {
            positionBuffer: gpu.positionBuffer,
            indexBuffer: gpu.indexBuffer,
            indexCount: gpu.indexCount,
            worldMatrix,
            meshUBO,
            bindGroup,
            _mesh: mesh,
            _lastWorldVersion: mesh.worldMatrixVersion,
        };
    });
}

/** Sync caster world matrices that have changed since last frame. */
export function syncCasterMatrices(engine: EngineContextInternal, casters: ShadowCaster[]): void {
    const device = engine.device;
    for (const c of casters) {
        if (c._mesh.worldMatrixVersion !== c._lastWorldVersion) {
            c.worldMatrix.set(c._mesh.worldMatrix as unknown as Float32Array);
            device.queue.writeBuffer(c.meshUBO, 0, c.worldMatrix as Float32Array<ArrayBuffer>);
            c._lastWorldVersion = c._mesh.worldMatrixVersion;
        }
    }
}

/** Write shadow generator state into a Float32Array(24) for UBO upload.
 *  Layout: [lightMatrix(16), depthValues.x, depthValues.y, 0, 0, shadowsInfo(4)] */
export function writeShadowUboFields(out: Float32Array, sg: { lightMatrix: Float32Array; depthValues: Float32Array; shadowsInfo: Float32Array }): void {
    out.set(sg.lightMatrix, 0);
    out[16] = sg.depthValues[0]!;
    out[17] = sg.depthValues[1]!;
    out[18] = 0;
    out[19] = 0;
    out[20] = sg.shadowsInfo[0]!;
    out[21] = sg.shadowsInfo[1]!;
    out[22] = sg.shadowsInfo[2]!;
    out[23] = sg.shadowsInfo[3]!;
}

/** Compare two Float32Array(16) matrices. Returns true if any element differs. */
export function shadowMatrixChanged(a: Float32Array, b: Float32Array): boolean {
    for (let i = 0; i < 16; i++) {
        if (a[i] !== b[i]) {
            return true;
        }
    }
    return false;
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

/** Create the shared depth-scene BGL (single uniform at binding 0, vertex stage). */
export function createDepthSceneBGL(engine: EngineContextInternal, label: string): GPUBindGroupLayout {
    return createSingleUniformBGL(engine, label, GPUShaderStage.VERTEX);
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

/** PCF depth textures use Babylon's clip-space linear bias path. WebGPU's
 *  half-Z NDC range applies the same 0.5 bias factor as Babylon.js. */
export function createPcfDepthSceneData(viewProj: Float32Array, bias: number): Float32Array {
    const data = new Float32Array(20);
    data.set(viewProj);
    data[16] = bias * 0.5;
    return data;
}

/** Create the shared receiver-side shadow UBO (96 bytes), initialised from state. */
export function createSharedShadowUBO(
    engine: EngineContextInternal,
    lightMatrix: Float32Array,
    depthValues: Float32Array,
    shadowsInfo: Float32Array
): { ubo: GPUBuffer; data: Float32Array } {
    const data = new Float32Array(24);
    writeShadowUboFields(data, { lightMatrix, depthValues, shadowsInfo });
    const ubo = createUniformBuffer(engine, data);
    return { ubo, data };
}

/** Draw all casters into the current render pass. */
export function drawCasters(pass: GPURenderPassEncoder, casters: ShadowCaster[]): void {
    for (let i = 0; i < casters.length; i++) {
        const c = casters[i]!;
        pass.setVertexBuffer(0, c.positionBuffer);
        pass.setIndexBuffer(c.indexBuffer, "uint32");
        pass.setBindGroup(1, c.bindGroup);
        pass.drawIndexed(c.indexCount);
    }
}

export interface ShadowDepthInfraOptions {
    label: string;
    viewProj: Float32Array;
    depthSceneData?: Float32Array;
    casterMeshes: Mesh[];
    vertCode: string;
    fragCode?: string;
    colorTargets?: GPUColorTargetState[];
    depthBias?: number;
    depthBiasSlopeScale?: number;
    extraMeshEntries?: GPUBindGroupEntry[];
    extraMeshBglEntries?: GPUBindGroupLayoutEntry[];
}

export interface ShadowDepthInfra {
    depthMeshBGL: GPUBindGroupLayout;
    depthSceneBGL: GPUBindGroupLayout;
    depthSceneBG: GPUBindGroup;
    depthSceneUBO: GPUBuffer;
    depthPipeline: GPURenderPipeline;
    casters: ShadowCaster[];
}

/** Create the shared shadow depth-pass infra: BGLs, scene UBO/BG, caster list, and depth pipeline. */
export function createShadowDepthInfra(engine: EngineContextInternal, opts: ShadowDepthInfraOptions): ShadowDepthInfra {
    const device = engine.device;
    const label = opts.label;

    const meshBglEntries: GPUBindGroupLayoutEntry[] = [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } }];
    if (opts.extraMeshBglEntries) {
        for (const e of opts.extraMeshBglEntries) {
            meshBglEntries.push(e);
        }
    }
    const depthMeshBGL = device.createBindGroupLayout({ label: `${label}-depth-mesh`, entries: meshBglEntries });
    const depthSceneBGL = createDepthSceneBGL(engine, `${label}-depth-scene`);
    const depthSceneUBO = createUniformBuffer(engine, (opts.depthSceneData ?? opts.viewProj) as Float32Array<ArrayBuffer>);
    const depthSceneBG = device.createBindGroup({ layout: depthSceneBGL, entries: [{ binding: 0, resource: { buffer: depthSceneUBO } }] });

    const casters = buildCasters(engine, opts.casterMeshes, depthMeshBGL, opts.extraMeshEntries);

    const vertModule = device.createShaderModule({ code: opts.vertCode, label: `${label}-depth-vert` });
    const fragModule = opts.fragCode ? device.createShaderModule({ code: opts.fragCode, label: `${label}-depth-frag` }) : undefined;

    const depthStencil: GPUDepthStencilState = { format: "depth32float", depthWriteEnabled: true, depthCompare: "less-equal" };
    if (opts.depthBias !== undefined) {
        depthStencil.depthBias = opts.depthBias;
    }
    if (opts.depthBiasSlopeScale !== undefined) {
        depthStencil.depthBiasSlopeScale = opts.depthBiasSlopeScale;
    }

    const pipelineDesc: GPURenderPipelineDescriptor = {
        label: `${label}-depth`,
        layout: device.createPipelineLayout({ bindGroupLayouts: [depthSceneBGL, depthMeshBGL] }),
        vertex: {
            module: vertModule,
            entryPoint: "main",
            buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" as GPUVertexFormat }] }],
        },
        depthStencil,
        primitive: { topology: "triangle-list", cullMode: "back", frontFace: "ccw" },
    };
    if (fragModule && opts.colorTargets) {
        pipelineDesc.fragment = { module: fragModule, entryPoint: "main", targets: opts.colorTargets };
    }

    const depthPipeline = device.createRenderPipeline(pipelineDesc);

    return { depthMeshBGL, depthSceneBGL, depthSceneBG, depthSceneUBO, depthPipeline, casters };
}

export interface ShadowDirtyTracker {
    /** Returns { dirty, lightChanged }. dirty=false means renderShadowMap can early-out. */
    check(light: { worldMatrixVersion: number }, casters: ShadowCaster[]): { dirty: boolean; lightChanged: boolean };
    commit(light: { worldMatrixVersion: number }, casters: ShadowCaster[]): void;
}

/** Per-generator dirty tracker for caster/light version changes. */
export function createShadowDirtyTracker(): ShadowDirtyTracker {
    let lastLv = -1;
    let lastSum = -1;
    let lastCount = -1;
    return {
        check(light, casters) {
            let sum = 0;
            for (const c of casters) {
                sum += c._mesh.worldMatrixVersion;
            }
            const lv = light.worldMatrixVersion;
            const lightChanged = lv !== lastLv || casters.length !== lastCount;
            const dirty = lightChanged || sum !== lastSum;
            return { dirty, lightChanged };
        },
        commit(light, casters) {
            let sum = 0;
            for (const c of casters) {
                sum += c._mesh.worldMatrixVersion;
            }
            lastLv = light.worldMatrixVersion;
            lastSum = sum;
            lastCount = casters.length;
        },
    };
}

/** Update the light matrix UBOs if the new viewProj differs from the cached one.
 *  Bumps sg._version, writes depthSceneUBO + sharedShadowUBO. Returns true if matrix changed. */
export function updateShadowLightMatrix(
    engine: EngineContextInternal,
    sg: { lightMatrix: Float32Array; depthValues: Float32Array; shadowsInfo: Float32Array; shadowUBO: GPUBuffer; _version: number },
    depthSceneUBO: GPUBuffer,
    newViewProj: Float32Array,
    sharedUboData: Float32Array
): boolean {
    if (!shadowMatrixChanged(sg.lightMatrix, newViewProj)) {
        return false;
    }
    sg.lightMatrix.set(newViewProj);
    sg._version++;
    const queue = engine.device.queue;
    queue.writeBuffer(depthSceneUBO, 0, sg.lightMatrix as Float32Array<ArrayBuffer>);
    writeShadowUboFields(sharedUboData, sg);
    queue.writeBuffer(sg.shadowUBO, 0, sharedUboData as Float32Array<ArrayBuffer>);
    return true;
}
