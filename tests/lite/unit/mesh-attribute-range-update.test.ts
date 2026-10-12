import { afterEach, describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import { initMeshTransform } from "../../../packages/babylon-lite/src/mesh/mesh";
import { updateMeshColors, updateMeshNormals, updateMeshPositions, updateMeshTangents, updateMeshUv2, updateMeshUvs } from "../../../packages/babylon-lite/src/mesh/mesh-factories";
import { createSceneNode } from "../../../packages/babylon-lite/src/scene/scene-node";
import * as composition from "../../../packages/babylon-lite/src/math/compose-mat4-into-buffer";

function fixture() {
    const buffers = {
        position: { size: 30 * 4 } as GPUBuffer,
        normal: { size: 30 * 4 } as GPUBuffer,
        color: { size: 40 * 4 } as GPUBuffer,
        uv: { size: 20 * 4 } as GPUBuffer,
        uv2: { size: 20 * 4 } as GPUBuffer,
        tangent: { size: 40 * 4 } as GPUBuffer,
    };
    const writeBuffer = vi.fn();
    const engine = { _device: { queue: { writeBuffer } } } as unknown as EngineContext;
    const mesh = initMeshTransform({
        _gpu: {
            positionBuffer: buffers.position,
            normalBuffer: buffers.normal,
            colorBuffer: buffers.color,
            uvBuffer: buffers.uv,
            uv2Buffer: buffers.uv2,
            tangentBuffer: buffers.tangent,
        } as Mesh["_gpu"],
    });
    return { buffers, writeBuffer, engine, mesh };
}

describe("mesh attribute range updates", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("retains local transforms during vertex attribute updates", () => {
        const { engine, mesh } = fixture();
        mesh.position.x = 1;
        const child = createSceneNode("child", 2);
        child.parent = mesh;
        expect(child.worldMatrix[12]).toBe(3);
        const compositions = vi.spyOn(composition, "composeMat4IntoBuffer");
        const values = new Float32Array(12);
        for (const update of [updateMeshPositions, updateMeshNormals, updateMeshColors, updateMeshUvs, updateMeshUv2, updateMeshTangents]) {
            const version = child.worldMatrixVersion;
            update(engine, mesh, values);
            expect(child.worldMatrixVersion).toBeGreaterThan(version);
            expect(child.worldMatrix[12]).toBe(3);
        }
        expect(compositions).not.toHaveBeenCalled();
    });

    it("uploads an exact source range without allocating a subarray", () => {
        const { buffers, writeBuffer, engine, mesh } = fixture();
        const positions = new Float32Array(30);
        const normals = new Float32Array(30);
        const colors = new Float32Array(40);
        const uvs = new Float32Array(20);
        const uv2 = new Float32Array(20);
        const tangents = new Float32Array(40);

        updateMeshPositions(engine, mesh, positions, 4, 3, 6);
        updateMeshNormals(engine, mesh, normals, 4, 3, 6);
        updateMeshColors(engine, mesh, colors, 4, 3, 6);
        updateMeshUvs(engine, mesh, uvs, 4, 3, 6);
        updateMeshUv2(engine, mesh, uv2, 4, 3, 6);
        updateMeshTangents(engine, mesh, tangents, 4, 3, 6);

        expect(writeBuffer.mock.calls).toEqual([
            [buffers.position, 4 * 3 * 4, positions.buffer, positions.byteOffset + 6 * 3 * 4, 3 * 3 * 4],
            [buffers.normal, 4 * 3 * 4, normals.buffer, normals.byteOffset + 6 * 3 * 4, 3 * 3 * 4],
            [buffers.color, 4 * 4 * 4, colors.buffer, colors.byteOffset + 6 * 4 * 4, 3 * 4 * 4],
            [buffers.uv, 4 * 2 * 4, uvs.buffer, uvs.byteOffset + 6 * 2 * 4, 3 * 2 * 4],
            [buffers.uv2, 4 * 2 * 4, uv2.buffer, uv2.byteOffset + 6 * 2 * 4, 3 * 2 * 4],
            [buffers.tangent, 4 * 4 * 4, tangents.buffer, tangents.byteOffset + 6 * 4 * 4, 3 * 4 * 4],
        ]);
    });

    it("preserves the whole-input default and rejects invalid source ranges", () => {
        const { writeBuffer, engine, mesh } = fixture();
        const values = new Float32Array(9);

        updateMeshPositions(engine, mesh, values, 2);
        expect(writeBuffer).toHaveBeenCalledWith(mesh._gpu.positionBuffer, 2 * 3 * 4, values.buffer, values.byteOffset, values.byteLength);
        expect(() => updateMeshPositions(engine, mesh, values, 0, 2, 2)).toThrow("valid tightly-packed vertex range");
        expect(() => updateMeshPositions(engine, mesh, values, 10, 1)).toThrow("valid destination vertex range");
    });

    it("does not dirty shadows for an empty valid range", () => {
        const { writeBuffer, engine, mesh } = fixture();
        const worldVersion = mesh.worldMatrixVersion;

        updateMeshPositions(engine, mesh, new Float32Array(0), 0, 0);

        expect(writeBuffer).not.toHaveBeenCalled();
        expect(mesh.worldMatrixVersion).toBe(worldVersion);
    });

    it("rejects updates to clone-shared geometry", () => {
        const { engine, mesh, writeBuffer } = fixture();
        mesh._gpu._refCount = 2;

        expect(() => updateMeshPositions(engine, mesh, new Float32Array(3))).toThrow("unshared, tightly-packed geometry");
        expect(writeBuffer).not.toHaveBeenCalled();
    });
});
