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

        const meshUBO = device.createBuffer({
            size: 64,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(meshUBO, 0, worldMatrix as Float32Array<ArrayBuffer>);

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
