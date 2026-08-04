import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { createLineMaterial } from "../../../packages/babylon-lite/src/material/line/line-material";
import { buildShaderMaterialRenderables } from "../../../packages/babylon-lite/src/material/shader/shader-renderable";
import { createLineSystemData, updateLineSystem } from "../../../packages/babylon-lite/src/mesh/create-line-system";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene";

function point(x: number, y: number, z: number) {
    return { x, y, z };
}

function color(r: number, g: number, b: number, a: number) {
    return { r, g, b, a };
}

function fakeBuffer(size = 256): GPUBuffer {
    return { size } as GPUBuffer;
}

describe("createLineSystemData", () => {
    it("flattens independent polylines without connecting their endpoints", () => {
        const data = createLineSystemData({
            lines: [[point(0, 0, 0), point(1, 0, 0), point(1, 1, 0)], [], [point(4, 0, 0)], [point(5, 0, 0), point(5, 1, 0)]],
            colors: [[color(1, 0, 0, 1), color(0, 1, 0, 0.75), color(0, 0, 1, 0.5)], [], [color(1, 1, 0, 1)], [color(1, 0, 1, 1), color(0, 1, 1, 0.25)]],
        });

        expect(Array.from(data.positions)).toEqual([0, 0, 0, 1, 0, 0, 1, 1, 0, 4, 0, 0, 5, 0, 0, 5, 1, 0]);
        expect(Array.from(data.indices)).toEqual([0, 1, 1, 2, 4, 5]);
        expect(Array.from(data.colors!)).toEqual([1, 0, 0, 1, 0, 1, 0, 0.75, 0, 0, 1, 0.5, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0.25]);
        expect(Array.from(data.linePointCounts)).toEqual([3, 0, 1, 2]);
        expect(data.normals).toHaveLength(data.positions.length);
        expect(Array.from(data.normals).every((value) => value === 0)).toBe(true);
    });

    it("rejects all-empty, mismatched-color, and non-finite input", () => {
        expect(() => createLineSystemData({ lines: [[], []] })).toThrow("at least one point");
        expect(() => createLineSystemData({ lines: [[point(0, 0, 0), point(1, 0, 0)]], colors: [[color(1, 1, 1, 1)]] })).toThrow("one color per point");
        expect(() => createLineSystemData({ lines: [[point(0, Number.NaN, 0)]] })).toThrow("finite");
        expect(() => createLineSystemData({ lines: [[point(0, 0, 0)]], colors: [[color(1, 1, 1, Number.POSITIVE_INFINITY)]] })).toThrow("finite");
    });
});

describe("createLineMaterial", () => {
    it("creates line-list shader variants for uniform, vertex, and thin-instance colors", () => {
        const uniform = createLineMaterial({ color: color(0.2, 0.4, 0.6, 0.8) });
        expect(uniform._topology).toBe("line-list");
        expect(uniform.attributes).toEqual(["position"]);
        expect(uniform.needAlphaBlending).toBe(true);
        expect(uniform.color).toEqual(color(0.2, 0.4, 0.6, 0.8));
        expect(uniform.vertexSource).not.toContain("world0");

        const vertex = createLineMaterial({ useVertexColor: true, useVertexAlpha: false });
        expect(vertex.attributes).toEqual(["position", "color"]);
        expect(vertex.needAlphaBlending).toBe(false);
        expect(vertex.vertexSource).toContain("input.color");

        const instanced = createLineMaterial({ useThinInstances: true, useThinInstanceColors: true });
        expect(instanced.useThinInstances).toBe(true);
        expect(instanced.useThinInstanceColors).toBe(true);
        expect(instanced.vertexSource).toContain("input.world0");
        expect(instanced.vertexSource).toContain("input.instanceColor");
    });

    it("rejects thin-instance colors without thin-instance matrices", () => {
        expect(() => createLineMaterial({ useThinInstanceColors: true })).toThrow("useThinInstances");
    });

    it("rejects a thin-instance shader variant on a mesh without thin-instance data", () => {
        const material = createLineMaterial({ useThinInstances: true });
        const mesh = { material, thinInstances: null } as unknown as Mesh;
        expect(() => buildShaderMaterialRenderables({} as SceneContext, [mesh])).toThrow("requires thin-instance data");
    });
});

describe("updateLineSystem", () => {
    it("updates positions and optional colors in place while preserving topology", () => {
        const positionBuffer = fakeBuffer();
        const colorBuffer = fakeBuffer();
        const writeBuffer = vi.fn();
        const captureMesh = vi.fn();
        const engine = {
            _device: { queue: { writeBuffer } },
            _dlr: { m: captureMesh },
        } as unknown as EngineContext;
        const oldColors = new Float32Array([1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1]);
        const indices = new Uint32Array([0, 1, 1, 2]);
        const mesh = {
            name: "lines",
            _linePointCounts: new Uint32Array([3]),
            _gpu: {
                positionBuffer,
                normalBuffer: fakeBuffer(),
                uvBuffer: fakeBuffer(),
                colorBuffer,
                indexBuffer: fakeBuffer(),
                indexCount: 4,
                indexFormat: "uint32",
                hasColor: true,
            },
            _cpuPositions: new Float32Array(9),
            _cpuNormals: new Float32Array(9),
            _cpuColors: oldColors,
            _cpuIndices: indices,
            _cpuGpuIndices: indices,
            _cpuIndexFormat: "uint32",
        } as unknown as Mesh;

        updateLineSystem(engine, mesh, { lines: [[point(-2, -1, 0), point(0, 2, 0), point(3, -1, 0)]] });

        expect(writeBuffer).toHaveBeenCalledTimes(1);
        expect(writeBuffer.mock.calls[0]![0]).toBe(positionBuffer);
        expect(mesh._cpuPositions).toEqual(new Float32Array([-2, -1, 0, 0, 2, 0, 3, -1, 0]));
        expect(mesh._cpuColors).toBe(oldColors);
        expect(mesh.boundMin).toEqual([-2, -1, 0]);
        expect(mesh.boundMax).toEqual([3, 2, 0]);
        expect(captureMesh).toHaveBeenCalledWith(mesh, null, null, oldColors, indices, "uint32");

        const nextColors = [[color(1, 1, 1, 0.25), color(1, 0, 0, 0.5), color(0, 0, 1, 0.75)]];
        updateLineSystem(engine, mesh, { lines: [[point(-1, 0, 0), point(0, 1, 0), point(1, 0, 0)]], colors: nextColors });
        expect(writeBuffer.mock.calls.at(-1)![0]).toBe(colorBuffer);
        expect(mesh._cpuColors).toEqual(new Float32Array([1, 1, 1, 0.25, 1, 0, 0, 0.5, 0, 0, 1, 0.75]));
    });

    it("rejects topology and color-layout changes before writing", () => {
        const writeBuffer = vi.fn();
        const engine = { _device: { queue: { writeBuffer } } } as unknown as EngineContext;
        const mesh = {
            name: "lines",
            _linePointCounts: new Uint32Array([2, 2]),
            _gpu: {
                positionBuffer: fakeBuffer(),
                normalBuffer: fakeBuffer(),
                uvBuffer: fakeBuffer(),
                colorBuffer: null,
                indexBuffer: fakeBuffer(),
                indexCount: 4,
                indexFormat: "uint32",
                hasColor: false,
            },
            _cpuPositions: new Float32Array(12),
            _cpuNormals: new Float32Array(12),
            _cpuIndices: new Uint32Array([0, 1, 2, 3]),
        } as unknown as Mesh;

        expect(() => updateLineSystem(engine, mesh, { lines: [[point(0, 0, 0)], [point(1, 0, 0), point(2, 0, 0), point(3, 0, 0)]] })).toThrow("unchanged line and point counts");
        expect(() =>
            updateLineSystem(engine, mesh, {
                lines: [
                    [point(0, 0, 0), point(1, 0, 0)],
                    [point(2, 0, 0), point(3, 0, 0)],
                ],
                colors: [
                    [color(1, 1, 1, 1), color(1, 1, 1, 1)],
                    [color(1, 1, 1, 1), color(1, 1, 1, 1)],
                ],
            })
        ).toThrow("without vertex colors");
        expect(writeBuffer).not.toHaveBeenCalled();
    });
});
