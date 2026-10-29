import { describe, expect, it, vi } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { GltfLoadCtx } from "../../../packages/babylon-lite/src/loader-gltf/gltf-feature";
import type { GltfMeshData } from "../../../packages/babylon-lite/src/loader-gltf/load-gltf";
import morphFeature from "../../../packages/babylon-lite/src/loader-gltf/gltf-feature-morph";
import { initMeshTransform } from "../../../packages/babylon-lite/src/mesh/mesh";
import { createMorphTargets, setMorphTargetWeights } from "../../../packages/babylon-lite/src/morph/create-morph-targets";

function engineFixture() {
    const createBuffer = vi.fn((descriptor: GPUBufferDescriptor) => ({
        getMappedRange: () => new ArrayBuffer(Number(descriptor.size)),
        unmap: vi.fn(),
    }));
    const writeBuffer = vi.fn();
    const engine = { _device: { createBuffer, queue: { writeBuffer } } } as unknown as EngineContext;
    return { engine, createBuffer, writeBuffer };
}

const targets = [{ positions: new Float32Array([1, 0, 0]), normals: null }];

describe("morph target discovery", () => {
    it("retains authored names and preserves them across a recovery-style assign", () => {
        const { engine, writeBuffer } = engineFixture();
        const names = ["Smile"] as const;
        const data = createMorphTargets(engine, targets, 1, [0.25], names);
        expect(data.names).toBe(names);
        expect(data.weights[0]).toBe(0.25);
        Object.assign(data, createMorphTargets(engine, targets, 1, [0.5]));
        expect(data.names).toBe(names);
        setMorphTargetWeights(engine, data, [0.75]);
        expect(data.weights[0]).toBe(0.75);
        expect(writeBuffer).toHaveBeenCalledOnce();
        data._disposed = true;
        expect(() => setMorphTargetWeights(engine, data, [0])).toThrow("Cannot update disposed morph targets");
    });

    it("omits the own names property when none were supplied", () => {
        const { engine } = engineFixture();
        expect(Object.hasOwn(createMorphTargets(engine, targets, 1, null), "names")).toBe(false);
    });

    it.each([{ names: [] }, { names: ["Smile", "Blink"] }])("retains mismatched authored names $names without changing target data", ({ names }) => {
        const { engine, createBuffer } = engineFixture();
        const data = createMorphTargets(engine, targets, 1, [0.25], names);
        expect(data.names).toBe(names);
        expect(data.count).toBe(1);
        expect(data.targets).toBe(targets);
        expect(Array.from(data.weights)).toEqual([0.25]);
        expect(createBuffer).toHaveBeenCalledTimes(2);
    });

    it.each([
        { names: ["Smile"], expected: ["Smile"] },
        { names: undefined, expected: undefined },
        { names: "Smile", expected: undefined },
        { names: [1], expected: undefined },
        { names: [], expected: undefined },
        { names: ["Smile", "Blink"], expected: undefined },
    ])("accepts only valid glTF targetNames: $names", async ({ names, expected }) => {
        const { engine } = engineFixture();
        const mesh = initMeshTransform({ name: "morph" });
        const meshData = { _nodeIndex: 0, _vertexCount: 1, _primitive: { targets: [{}] } } as GltfMeshData;
        const ctx = {
            _engine: engine,
            _json: { nodes: [{ mesh: 0 }], meshes: [{ extras: { targetNames: names }, weights: [0.25] }] },
            _binChunk: new DataView(new ArrayBuffer(0)),
        } as GltfLoadCtx;
        await morphFeature.applyMesh!(meshData, mesh, ctx);
        expect(mesh.morphTargets!.names).toEqual(expected);
        expect(Object.hasOwn(mesh.morphTargets!, "names")).toBe(expected !== undefined);
        if (expected) {
            expect(mesh.morphTargets!.names).toBe(names);
        }
    });
});
