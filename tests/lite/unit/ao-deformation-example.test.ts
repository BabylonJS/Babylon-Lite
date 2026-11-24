import { describe, expect, it, vi } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import { buildBeamData } from "../../../lab/lite/src/shared/scene231-skin.js";

const load = vi.hoisted(() => vi.fn((_engine: EngineContext, _source: string | ArrayBuffer | Blob) => Promise.resolve({ entities: [] })));
vi.mock("../../../packages/babylon-lite/src/index.js", () => ({ loadGltf: load }));

// Keep demo-only dependencies out of the tests' TypeScript project, as in racer-vehicle.test.ts.
const exampleModule = "../../../lab/lite/src/demos/ambient-occlusion-deformation.js";
const { createAoDeformationExamples } = (await import(exampleModule)) as { createAoDeformationExamples: (engine: EngineContext) => Promise<unknown> };

interface FixtureGltf {
    buffers: { uri: string }[];
    bufferViews: { byteOffset: number }[];
    accessors: { bufferView: number; count: number; componentType: number }[];
    materials: { doubleSided?: boolean }[];
    meshes: { primitives: { indices: number; attributes: { POSITION: number; NORMAL: number }; targets?: { POSITION: number; NORMAL: number }[] }[] }[];
}

describe("AO deformation example glTF winding", () => {
    it("encodes outward CCW triangles for both meshes, including caps and morphed positions", async () => {
        await createAoDeformationExamples({} as EngineContext);
        const source = load.mock.calls.at(-1)![1];
        if (!(source instanceof Blob)) {
            throw new Error("AO deformation examples must load a self-contained glTF Blob");
        }
        const gltf = JSON.parse(await source.text()) as FixtureGltf;
        const bytes = Uint8Array.from(atob(gltf.buffers[0]!.uri.split(",")[1]!), (character) => character.charCodeAt(0));
        const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const vector = (accessor: number, vertex: number): number[] => {
            const view = gltf.bufferViews[gltf.accessors[accessor]!.bufferView]!;
            return [0, 1, 2].map((axis) => data.getFloat32(view.byteOffset + (vertex * 3 + axis) * 4, true));
        };
        expect(gltf.meshes).toHaveLength(2);
        for (const material of gltf.materials) {
            expect(material.doubleSided).not.toBe(true);
        }
        for (const mesh of gltf.meshes) {
            expect(mesh.primitives).toHaveLength(1);
            const primitive = mesh.primitives[0]!;
            expect(primitive.indices).toBe(gltf.meshes[0]!.primitives[0]!.indices);
            const indices = gltf.accessors[primitive.indices]!;
            expect(indices.componentType).toBe(5125);
            expect(indices.count).toBe(396);
            const start = gltf.bufferViews[indices.bufferView]!.byteOffset;
            for (const weight of primitive.targets ? [0, 0.5, 1] : [0]) {
                for (let triangle = 0; triangle < indices.count; triangle += 3) {
                    const vertices = [0, 1, 2].map((corner) => data.getUint32(start + (triangle + corner) * 4, true));
                    const positions = vertices.map((vertex) => {
                        const base = vector(primitive.attributes.POSITION, vertex);
                        const delta = primitive.targets ? vector(primitive.targets[0]!.POSITION, vertex) : [0, 0, 0];
                        return base.map((value, axis) => value + weight * delta[axis]!);
                    });
                    const normals = vertices.map((vertex) => {
                        const base = vector(primitive.attributes.NORMAL, vertex);
                        const delta = primitive.targets ? vector(primitive.targets[0]!.NORMAL, vertex) : [0, 0, 0];
                        return base.map((value, axis) => value + weight * delta[axis]!);
                    });
                    const a = positions[1]!.map((value, axis) => value - positions[0]![axis]!);
                    const b = positions[2]!.map((value, axis) => value - positions[0]![axis]!);
                    const cross = [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
                    for (const normal of normals) {
                        const agreement = cross.reduce((sum, value, axis) => sum + value * normal[axis]!, 0);
                        expect(agreement, `triangle ${triangle / 3}, morph ${weight}`).toBeGreaterThan(0);
                    }
                }
            }
        }
        const original = buildBeamData();
        const encodedIndices = gltf.meshes[0]!.primitives[0]!.indices;
        const start = gltf.bufferViews[gltf.accessors[encodedIndices]!.bufferView]!.byteOffset;
        expect(data.getUint32(start, true)).toBe(original.indices[0]);
        expect(data.getUint32(start + 4, true)).toBe(original.indices[2]);
        expect(data.getUint32(start + 8, true)).toBe(original.indices[1]);
    });
});
