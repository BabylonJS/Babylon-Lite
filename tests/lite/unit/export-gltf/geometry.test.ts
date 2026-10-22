import { describe, expect, it } from "vitest";
import { attach, createMesh, createScene, exportAndParse, QUAD_INDICES, readAccessor } from "./export-test-utils";
import type { ParsedGlb } from "./export-test-utils";
import { createTransformNode } from "../../../../packages/babylon-lite/src/scene/transform-node";
import { composeMat4 } from "../../../../packages/babylon-lite/src/math/compose-mat4";
import type { Mesh } from "../../../../packages/babylon-lite/src/mesh/mesh";

const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const SQRT1_2 = Math.SQRT1_2;
const FORWARD_INDICES = [0, 1, 2, 0, 2, 3];
const REVERSED_INDICES = [0, 2, 1, 0, 3, 2];

function expectClose(actual: ArrayLike<number> | undefined, expected: number[]): void {
    expect(actual).toBeDefined();
    expect(actual!.length).toBe(expected.length);
    for (let i = 0; i < expected.length; i++) {
        expect(actual![i]).toBeCloseTo(expected[i]!, 5);
    }
}

/** Export one mesh at the scene root (a converting pass). */
async function exportMesh(mesh: Mesh): Promise<ParsedGlb> {
    return exportAndParse(createScene({ meshes: [mesh] }));
}

/** Export one mesh under the glTF loader's conversion root (a pass-through pass). */
async function exportPassThrough(mesh: Mesh): Promise<ParsedGlb> {
    attach(mesh, createTransformNode("__root__", 0, 0, 0, 0, 0, 0, 1, -1, 1, 1));
    return exportAndParse(createScene({ meshes: [mesh] }));
}

function firstPrimitive(glb: ParsedGlb) {
    return glb.json.meshes[0].primitives[0];
}

describe("attributes", () => {
    it("exports POSITION, NORMAL and TEXCOORD_0 for a default mesh", async () => {
        const glb = await exportMesh(createMesh("m"));
        expect(Object.keys(firstPrimitive(glb).attributes).sort()).toEqual(["NORMAL", "POSITION", "TEXCOORD_0"]);
        expect(glb.json.accessors[firstPrimitive(glb).attributes.POSITION]).toMatchObject({ componentType: FLOAT, count: 4, type: "VEC3" });
        expect(glb.json.accessors[firstPrimitive(glb).attributes.TEXCOORD_0]).toMatchObject({ componentType: FLOAT, count: 4, type: "VEC2" });
        expect(glb.warnings).toEqual([]);
    });

    it("omits NORMAL for a flat-shaded mesh", async () => {
        const glb = await exportMesh(createMesh("m", { extra: { _flatNormal: true } }));
        expect(firstPrimitive(glb).attributes.NORMAL).toBeUndefined();
        expect(firstPrimitive(glb).attributes.POSITION).toBeDefined();
    });

    it("omits attributes that are absent", async () => {
        const glb = await exportMesh(createMesh("m", { normals: null, uvs: null }));
        expect(Object.keys(firstPrimitive(glb).attributes)).toEqual(["POSITION"]);
    });

    it("exports TANGENT, TEXCOORD_1 and COLOR_0 when the CPU arrays are present", async () => {
        const glb = await exportMesh(
            createMesh("m", {
                tangents: new Float32Array(16).fill(0.5),
                uv2s: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
                colors: new Float32Array(16).fill(0.25),
            })
        );
        const attributes = firstPrimitive(glb).attributes;
        expect(glb.json.accessors[attributes.TANGENT]).toMatchObject({ type: "VEC4", count: 4 });
        expect(glb.json.accessors[attributes.TEXCOORD_1]).toMatchObject({ type: "VEC2", count: 4 });
        expect(glb.json.accessors[attributes.COLOR_0]).toMatchObject({ type: "VEC4", count: 4 });
    });

    it("warns and omits tangents, second UVs and colors that exist only on the GPU", async () => {
        const glb = await exportMesh(createMesh("m", { gpuOnly: ["tangent", "uv2", "color"] }));
        const attributes = firstPrimitive(glb).attributes;
        expect(attributes.TANGENT).toBeUndefined();
        expect(attributes.TEXCOORD_1).toBeUndefined();
        expect(attributes.COLOR_0).toBeUndefined();
        expect(glb.warnings).toContain('Mesh "m" has tangents on the GPU only; exporting the mesh without them.');
        expect(glb.warnings).toContain('Mesh "m" has a second UV set on the GPU only; exporting the mesh without them.');
        expect(glb.warnings).toContain('Mesh "m" has vertex colors on the GPU only; exporting the mesh without them.');
    });

    it("warns and omits an attribute whose length does not match the positions", async () => {
        const glb = await exportMesh(createMesh("m", { normals: new Float32Array(9), uvs: new Float32Array(6) }));
        expect(firstPrimitive(glb).attributes.NORMAL).toBeUndefined();
        expect(firstPrimitive(glb).attributes.TEXCOORD_0).toBeUndefined();
        expect(firstPrimitive(glb).attributes.POSITION).toBeDefined();
        expect(glb.warnings).toContain('Mesh "m" has normals whose length does not match its positions; exporting the mesh without them.');
        expect(glb.warnings).toContain('Mesh "m" has UVs whose length does not match its positions; exporting the mesh without them.');
    });

    it("exports TEXCOORD_1 whenever uv2s is present", async () => {
        const uv2s = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
        const glb = await exportMesh(createMesh("m", { uv2s }));
        expectClose(readAccessor(glb, firstPrimitive(glb).attributes.TEXCOORD_1), Array.from(uv2s));
    });

    it("warns and omits a second UV set with the wrong length", async () => {
        const glb = await exportMesh(createMesh("m", { uv2s: new Float32Array(4) }));
        expect(firstPrimitive(glb).attributes.TEXCOORD_1).toBeUndefined();
        expect(glb.warnings).toContain('Mesh "m" has second UV set whose length does not match its positions; exporting the mesh without them.');
    });
});

describe("handedness conversion", () => {
    it("negates X of positions and normals and renormalizes the normals in a converting pass", async () => {
        const glb = await exportMesh(
            createMesh("m", {
                positions: new Float32Array([1, 2, 3, -4, 5, 6, 7, 8, 9]),
                normals: new Float32Array([2, 0, 0, 0, 3, 0, 1, 1, 0]),
                uvs: new Float32Array([0, 0, 1, 0, 1, 1]),
                indices: new Uint32Array([0, 1, 2]),
            })
        );
        const attributes = firstPrimitive(glb).attributes;
        expectClose(readAccessor(glb, attributes.POSITION), [-1, 2, 3, 4, 5, 6, -7, 8, 9]);
        expectClose(readAccessor(glb, attributes.NORMAL), [-1, 0, 0, 0, 1, 0, -SQRT1_2, SQRT1_2, 0]);
    });

    it("converts tangents: X negated, xyz renormalized, w negated", async () => {
        const glb = await exportMesh(
            createMesh("m", {
                positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
                normals: new Float32Array([0, 0, -1, 0, 0, -1, 0, 0, -1]),
                uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
                tangents: new Float32Array([2, 0, 0, 1, 0, 3, 0, -1, 3, 4, 0, 1]),
                indices: new Uint32Array([0, 1, 2]),
            })
        );
        expectClose(readAccessor(glb, firstPrimitive(glb).attributes.TANGENT), [-1, 0, 0, -1, 0, 1, 0, 1, -0.6, 0.8, 0, -1]);
    });

    it("does not touch UVs and colors in a converting pass", async () => {
        const uvs = new Float32Array([0.25, 0.75, 0.5, 0.5, 1, 0, 0, 1]);
        const colors = new Float32Array([1, 0.5, 0.25, 1, 0, 0, 0, 0.5, 1, 1, 1, 1, 0.1, 0.2, 0.3, 0.4]);
        const glb = await exportMesh(createMesh("m", { uvs, colors }));
        expectClose(readAccessor(glb, firstPrimitive(glb).attributes.TEXCOORD_0), Array.from(uvs));
        expectClose(readAccessor(glb, firstPrimitive(glb).attributes.COLOR_0), Array.from(colors));
    });

    it("copies attributes verbatim in a pass-through pass", async () => {
        const positions = new Float32Array([1, 2, 3, -4, 5, 6, 7, 8, 9]);
        const normals = new Float32Array([1, 0, 0, 0, -1, 0, SQRT1_2, SQRT1_2, 0]);
        const tangents = new Float32Array([0, 0, 1, 1, 0, 1, 0, -1, SQRT1_2, 0, SQRT1_2, 1]);
        const glb = await exportPassThrough(
            createMesh("m", { authoredSign: -1, positions, normals, tangents, uvs: new Float32Array([0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) })
        );
        const attributes = firstPrimitive(glb).attributes;
        expect(readAccessor(glb, attributes.POSITION)).toEqual(Array.from(positions));
        expect(readAccessor(glb, attributes.NORMAL)).toEqual(Array.from(normals));
        expect(readAccessor(glb, attributes.TANGENT)).toEqual(Array.from(tangents));
    });

    it("renormalizes non-unit normal and tangent vectors in a pass-through pass, leaving tangent w alone", async () => {
        const glb = await exportPassThrough(
            createMesh("m", {
                authoredSign: -1,
                positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
                normals: new Float32Array([2, 0, 0, 0, 3, 0, 1, 1, 0]),
                tangents: new Float32Array([0, 0, 4, 1, 3, 0, 0, -1, 0, 0, 0, 1]),
                uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
                indices: new Uint32Array([0, 1, 2]),
            })
        );
        const attributes = firstPrimitive(glb).attributes;
        expectClose(readAccessor(glb, attributes.NORMAL), [1, 0, 0, 0, 1, 0, SQRT1_2, SQRT1_2, 0]);
        // The zero-length tangent is left as it is.
        expectClose(readAccessor(glb, attributes.TANGENT), [0, 0, 1, 1, 1, 0, 0, -1, 0, 0, 0, 1]);
    });

    it("computes POSITION min/max over the emitted (converted) data", async () => {
        const glb = await exportMesh(
            createMesh("m", { positions: new Float32Array([1, -1, 0.5, 2, 3, 0.25, 3, 2, -2]), normals: null, uvs: null, indices: new Uint32Array([0, 1, 2]) })
        );
        const accessor = glb.json.accessors[firstPrimitive(glb).attributes.POSITION];
        expect(accessor.min).toEqual([-3, -1, -2]);
        expect(accessor.max).toEqual([-1, 3, 0.5]);
    });

    it("computes POSITION min/max over the emitted data in a pass-through pass", async () => {
        const glb = await exportPassThrough(
            createMesh("m", { authoredSign: -1, positions: new Float32Array([1, -1, 0.5, 2, 3, 0.25, 3, 2, -2]), normals: null, uvs: null, indices: new Uint32Array([0, 1, 2]) })
        );
        const accessor = glb.json.accessors[firstPrimitive(glb).attributes.POSITION];
        expect(accessor.min).toEqual([1, -1, -2]);
        expect(accessor.max).toEqual([3, 3, 0.5]);
    });
});

describe("indices", () => {
    it("exports UNSIGNED_SHORT when every index is below 65535", async () => {
        const glb = await exportMesh(createMesh("m", { indices: new Uint32Array([0, 1, 2, 0, 2, 65534]) }));
        const accessor = glb.json.accessors[firstPrimitive(glb).indices];
        expect(accessor.componentType).toBe(UNSIGNED_SHORT);
        expect(accessor.count).toBe(6);
        expect(readAccessor(glb, firstPrimitive(glb).indices)).toEqual([0, 1, 2, 0, 2, 65534]);
    });

    it("exports UNSIGNED_INT when any index reaches 65535", async () => {
        const glb = await exportMesh(createMesh("m", { indices: new Uint32Array([0, 1, 2, 0, 2, 65535]) }));
        expect(glb.json.accessors[firstPrimitive(glb).indices].componentType).toBe(UNSIGNED_INT);
        expect(readAccessor(glb, firstPrimitive(glb).indices)).toEqual([0, 1, 2, 0, 2, 65535]);
    });

    it("keeps the width of _cpuGpuIndices", async () => {
        const wide = await exportMesh(createMesh("m", { gpuIndices: new Uint32Array([0, 1, 2, 0, 2, 3]) }));
        expect(wide.json.accessors[firstPrimitive(wide).indices].componentType).toBe(UNSIGNED_INT);
        const narrow = await exportMesh(createMesh("m", { gpuIndices: new Uint16Array([0, 1, 2, 0, 2, 3]) }));
        expect(narrow.json.accessors[firstPrimitive(narrow).indices].componentType).toBe(UNSIGNED_SHORT);
        expect(readAccessor(narrow, firstPrimitive(narrow).indices)).toEqual(FORWARD_INDICES);
    });

    it("widens a retained Uint16 list that contains 65535 to UNSIGNED_INT", async () => {
        const glb = await exportMesh(createMesh("m", { gpuIndices: new Uint16Array([0, 1, 2, 0, 2, 65535]) }));
        expect(glb.json.accessors[firstPrimitive(glb).indices].componentType).toBe(UNSIGNED_INT);
        expect(readAccessor(glb, firstPrimitive(glb).indices)).toEqual([0, 1, 2, 0, 2, 65535]);
        const below = await exportMesh(createMesh("m", { gpuIndices: new Uint16Array([0, 1, 2, 0, 2, 65534]) }));
        expect(below.json.accessors[firstPrimitive(below).indices].componentType).toBe(UNSIGNED_SHORT);
    });

    it("keeps a retained Uint32 list 32-bit even when every value is small, and narrows a non-retained one", async () => {
        const retained = await exportMesh(createMesh("m", { gpuIndices: new Uint32Array([0, 1, 2]) }));
        expect(retained.json.accessors[firstPrimitive(retained).indices].componentType).toBe(UNSIGNED_INT);
        const cpuOnly = await exportMesh(createMesh("m", { indices: new Uint32Array([0, 1, 2]) }));
        expect(cpuOnly.json.accessors[firstPrimitive(cpuOnly).indices].componentType).toBe(UNSIGNED_SHORT);
    });

    it("prefers _cpuGpuIndices over _cpuIndices", async () => {
        const glb = await exportMesh(createMesh("m", { indices: new Uint32Array([3, 3, 3]), gpuIndices: new Uint16Array([0, 2, 1]) }));
        expect(readAccessor(glb, firstPrimitive(glb).indices)).toEqual([0, 2, 1]);
    });
});

describe("winding order", () => {
    const cases: { name: string; sign: number | undefined; passThrough: boolean; expected: number[] }[] = [
        { name: "converting + authoredSign unset keeps the index order", sign: undefined, passThrough: false, expected: FORWARD_INDICES },
        { name: "converting + authoredSign +1 keeps the index order", sign: 1, passThrough: false, expected: FORWARD_INDICES },
        { name: "converting + authoredSign -1 reverses the triangles", sign: -1, passThrough: false, expected: REVERSED_INDICES },
        { name: "pass-through + authoredSign -1 keeps the index order", sign: -1, passThrough: true, expected: FORWARD_INDICES },
        { name: "pass-through + authoredSign +1 reverses the triangles", sign: 1, passThrough: true, expected: REVERSED_INDICES },
        { name: "pass-through + authoredSign unset reverses the triangles", sign: undefined, passThrough: true, expected: REVERSED_INDICES },
    ];
    for (const c of cases) {
        it(c.name, async () => {
            const mesh = createMesh("m", { ...(c.sign !== undefined ? { authoredSign: c.sign } : {}) });
            const glb = await (c.passThrough ? exportPassThrough(mesh) : exportMesh(mesh));
            expect(readAccessor(glb, firstPrimitive(glb).indices)).toEqual(c.expected);
        });
    }

    it("reverses a copy: the source index array is untouched", async () => {
        const indices = QUAD_INDICES.slice();
        await exportMesh(createMesh("m", { authoredSign: -1, indices }));
        expect(Array.from(indices)).toEqual(FORWARD_INDICES);
        const gpuIndices = new Uint16Array(FORWARD_INDICES);
        await exportMesh(createMesh("m", { authoredSign: -1, gpuIndices }));
        expect(Array.from(gpuIndices)).toEqual(FORWARD_INDICES);
    });

    it("reverses _cpuGpuIndices keeping their width", async () => {
        const glb = await exportMesh(createMesh("m", { authoredSign: -1, gpuIndices: new Uint16Array(FORWARD_INDICES) }));
        expect(glb.json.accessors[firstPrimitive(glb).indices].componentType).toBe(UNSIGNED_SHORT);
        expect(readAccessor(glb, firstPrimitive(glb).indices)).toEqual(REVERSED_INDICES);
    });
});

describe("topology", () => {
    it("expands a triangle strip that needs a winding reversal into a reversed TRIANGLES list", async () => {
        // Strip (0, 1, 2, 3) is triangles (0, 1, 2) and (2, 1, 3); reversed they are (0, 2, 1) and (2, 3, 1).
        const mesh = createMesh("strip", { authoredSign: -1, indices: new Uint32Array([0, 1, 2, 3]), extra: { _topology: 4 } });
        const glb = await exportMesh(mesh);
        expect(firstPrimitive(glb).mode).toBeUndefined();
        expect(readAccessor(glb, firstPrimitive(glb).indices)).toEqual([0, 2, 1, 2, 3, 1]);
        expect(glb.json.accessors[firstPrimitive(glb).indices].count).toBe(6);
    });

    it("expands a longer reversed strip with alternating triangle order and keeps the source untouched", async () => {
        const indices = new Uint32Array([0, 1, 2, 3, 1]);
        const glb = await exportMesh(createMesh("strip", { authoredSign: -1, indices, extra: { _topology: 4 } }));
        // Triangles (0,1,2), (2,1,3), (2,3,1) reversed to (0,2,1), (2,3,1), (2,1,3).
        expect(readAccessor(glb, firstPrimitive(glb).indices)).toEqual([0, 2, 1, 2, 3, 1, 2, 1, 3]);
        expect(Array.from(indices)).toEqual([0, 1, 2, 3, 1]);
    });

    it("expands a reversed non-indexed triangle strip over its vertex sequence", async () => {
        const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]);
        const glb = await exportMesh(createMesh("strip", { authoredSign: -1, positions, normals: null, uvs: null, indices: null, extra: { _topology: 4 } }));
        expect(firstPrimitive(glb).mode).toBeUndefined();
        expect(readAccessor(glb, firstPrimitive(glb).indices)).toEqual([0, 2, 1, 2, 3, 1]);
    });

    it("exports a reversed strip with fewer than three indices as an empty triangle list without throwing", async () => {
        const glb = await exportMesh(createMesh("strip", { authoredSign: -1, indices: new Uint32Array([0, 1]), extra: { _topology: 4 } }));
        expect(glb.json.nodes).toHaveLength(1);
    });

    it("exports a triangle strip that needs no reversal as mode 5", async () => {
        const glb = await exportMesh(createMesh("strip", { extra: { _topology: 4 } }));
        expect(firstPrimitive(glb).mode).toBe(5);
        expect(readAccessor(glb, firstPrimitive(glb).indices)).toEqual(FORWARD_INDICES);
    });

    it("exports a loader-style triangle-strip primitive state as mode 5", async () => {
        const glb = await exportMesh(createMesh("strip", { extra: { _primitive: { topology: "triangle-strip" } } }));
        expect(firstPrimitive(glb).mode).toBe(5);
    });

    it("omits mode for triangle lists", async () => {
        const glb = await exportMesh(createMesh("m"));
        expect(firstPrimitive(glb).mode).toBeUndefined();
    });

    const modes: { name: string; extra: Record<string, unknown>; mode: number }[] = [
        { name: "_topology 1 (points)", extra: { _topology: 1 }, mode: 0 },
        { name: "_topology 2 (lines)", extra: { _topology: 2 }, mode: 1 },
        { name: "_topology 3 (line strip)", extra: { _topology: 3 }, mode: 3 },
        { name: "_primitive point-list", extra: { _primitive: { topology: "point-list" } }, mode: 0 },
        { name: "_primitive line-list", extra: { _primitive: { topology: "line-list" } }, mode: 1 },
        { name: "_primitive line-strip", extra: { _primitive: { topology: "line-strip" } }, mode: 3 },
    ];
    for (const c of modes) {
        it(`exports ${c.name} as mode ${c.mode} without winding reversal`, async () => {
            // authoredSign -1 under a converting pass would reverse a triangle list.
            const glb = await exportMesh(createMesh("m", { authoredSign: -1, extra: c.extra }));
            expect(firstPrimitive(glb).mode).toBe(c.mode);
            expect(readAccessor(glb, firstPrimitive(glb).indices)).toEqual(FORWARD_INDICES);
        });
    }
});

describe("non-indexed and empty geometry", () => {
    const sixVertices = () => new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 2, 1, 0]);

    it("synthesizes (0,2,1,3,5,4) UNSIGNED_SHORT indices for a non-indexed mesh that needs reversal", async () => {
        const glb = await exportMesh(createMesh("m", { authoredSign: -1, positions: sixVertices(), normals: null, uvs: null, indices: null }));
        const accessor = glb.json.accessors[firstPrimitive(glb).indices];
        expect(accessor.componentType).toBe(UNSIGNED_SHORT);
        expect(readAccessor(glb, firstPrimitive(glb).indices)).toEqual([0, 2, 1, 3, 5, 4]);
    });

    it("emits no indices for a non-indexed mesh that needs no reversal", async () => {
        const glb = await exportMesh(createMesh("m", { positions: sixVertices(), normals: null, uvs: null, indices: null }));
        expect(firstPrimitive(glb).indices).toBeUndefined();
        expect(glb.json.accessors[firstPrimitive(glb).attributes.POSITION].count).toBe(6);
    });

    it("exports a node without a mesh for an empty index array", async () => {
        const glb = await exportMesh(createMesh("m", { indices: new Uint32Array(0) }));
        expect(glb.json.nodes).toHaveLength(1);
        expect(glb.json.nodes[0].mesh).toBeUndefined();
        expect(glb.json.meshes).toBeUndefined();
    });

    it("exports a node without a mesh for zero positions", async () => {
        const glb = await exportMesh(createMesh("m", { positions: new Float32Array(0), normals: null, uvs: null }));
        expect(glb.json.nodes).toHaveLength(1);
        expect(glb.json.nodes[0].mesh).toBeUndefined();
        expect(glb.json.meshes).toBeUndefined();
    });

    it("warns and exports a node without a mesh when _cpuPositions is missing", async () => {
        const glb = await exportMesh(createMesh("m", { extra: { _cpuPositions: undefined } }));
        expect(glb.json.nodes).toHaveLength(1);
        expect(glb.json.nodes[0].mesh).toBeUndefined();
        expect(glb.warnings).toContain('Mesh "m" has no retained CPU geometry; exporting its node without a mesh.');
    });
});

describe("morph targets", () => {
    const morphMesh = (weights: number[]) =>
        createMesh("m", {
            extra: {
                morphTargets: {
                    targets: [
                        { positions: new Float32Array([1, 0, 0, 2, 1, 0, -3, 0, 1, 0.5, 0.5, 0.5]), normals: new Float32Array([0.5, 0, 0, 0, 0.5, 0, 0, 0, 0.5, -0.5, 0, 0]) },
                        { positions: new Float32Array([0, 1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 0]), normals: null },
                    ],
                    weights: new Float32Array(weights),
                    count: 2,
                },
            },
        });

    it.each([false, true])("keeps POSITION bounds when morph normals share their source array (pass-through: %s)", async (passThrough) => {
        const zero = new Float32Array(12);
        const mesh = createMesh("m", {
            extra: {
                morphTargets: {
                    targets: [
                        { positions: new Float32Array(12).fill(0.5), normals: zero },
                        { positions: zero, normals: new Float32Array(12).fill(0.25) },
                    ],
                    weights: new Float32Array([0.5, 0.5]),
                    count: 2,
                },
            },
        });
        const glb = await (passThrough ? exportPassThrough(mesh) : exportMesh(mesh));
        const targets = firstPrimitive(glb).targets;
        const position = glb.json.accessors[targets[1].POSITION];
        expect(position.min).toEqual([0, 0, 0]);
        expect(position.max).toEqual([0, 0, 0]);
        expect(targets[1].POSITION).not.toBe(targets[0].NORMAL);
    });

    it("exports converted deltas with POSITION min/max and the current weights", async () => {
        const glb = await exportMesh(morphMesh([0.5, 0.25]));
        const primitive = firstPrimitive(glb);
        expect(primitive.targets).toHaveLength(2);
        const positionAccessor = glb.json.accessors[primitive.targets[0].POSITION];
        expect(positionAccessor.min).toEqual([-2, 0, 0]);
        expect(positionAccessor.max).toEqual([3, 1, 1]);
        expectClose(readAccessor(glb, primitive.targets[0].POSITION), [-1, 0, 0, -2, 1, 0, 3, 0, 1, -0.5, 0.5, 0.5]);
        expectClose(readAccessor(glb, primitive.targets[0].NORMAL), [-0.5, 0, 0, 0, 0.5, 0, 0, 0, 0.5, 0.5, 0, 0]);
        expect(primitive.targets[1].NORMAL).toBeUndefined();
        expectClose(readAccessor(glb, primitive.targets[1].POSITION), [0, 1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 0]);
        expect(glb.json.meshes[0].weights).toEqual([0.5, 0.25]);
    });

    it("copies morph deltas verbatim in a pass-through pass", async () => {
        const mesh = morphMesh([1, 0]);
        (mesh as { _authoredSign?: number })._authoredSign = -1;
        const glb = await exportPassThrough(mesh);
        expectClose(readAccessor(glb, firstPrimitive(glb).targets[0].POSITION), [1, 0, 0, 2, 1, 0, -3, 0, 1, 0.5, 0.5, 0.5]);
    });

    it("drops all morph targets and their weights, with a warning, when a target's positions length mismatches", async () => {
        const mesh = createMesh("m", { extra: { morphTargets: { targets: [{ positions: new Float32Array(6), normals: null }], weights: new Float32Array([1]), count: 1 } } });
        const glb = await exportMesh(mesh);
        expect(firstPrimitive(glb).targets).toBeUndefined();
        expect(glb.json.meshes[0].weights).toBeUndefined();
        expect(glb.warnings).toEqual(['Mesh "m" has morph targets whose length does not match its positions; exporting the mesh without them.']);
    });

    it("drops every target when only one of several mismatches", async () => {
        const good = { positions: new Float32Array(12), normals: null };
        const bad = { positions: new Float32Array(9), normals: null };
        const mesh = createMesh("m", { extra: { morphTargets: { targets: [good, bad], weights: new Float32Array([0.5, 0.5]), count: 2 } } });
        const glb = await exportMesh(mesh);
        expect(firstPrimitive(glb).targets).toBeUndefined();
        expect(glb.json.meshes[0].weights).toBeUndefined();
        expect(glb.warnings).toHaveLength(1);
    });

    it("emits target NORMAL deltas only when the base NORMAL is emitted", async () => {
        const targets = [{ positions: new Float32Array(12), normals: new Float32Array([0.5, 0, 0, 0, 0.5, 0, 0, 0, 0.5, -0.5, 0, 0]) }];
        const morphTargets = { targets, weights: new Float32Array([1]), count: 1 };
        const withNormals = await exportMesh(createMesh("m", { extra: { morphTargets } }));
        expect(firstPrimitive(withNormals).attributes.NORMAL).toBeDefined();
        expect(firstPrimitive(withNormals).targets[0].NORMAL).toBeDefined();
        const without = await exportMesh(createMesh("m", { normals: null, extra: { morphTargets } }));
        expect(firstPrimitive(without).attributes.NORMAL).toBeUndefined();
        expect(firstPrimitive(without).targets[0].NORMAL).toBeUndefined();
        expect(firstPrimitive(without).targets[0].POSITION).toBeDefined();
    });

    it("writes exactly one weight per target, padding missing weights with 0 and ignoring extras", async () => {
        const targets = [0, 1, 2].map(() => ({ positions: new Float32Array(12), normals: null }));
        const padded = await exportMesh(createMesh("m", { extra: { morphTargets: { targets, weights: new Float32Array([0.5]), count: 3 } } }));
        expect(padded.json.meshes[0].weights).toEqual([0.5, 0, 0]);
        const longer = await exportMesh(createMesh("m", { extra: { morphTargets: { targets: targets.slice(0, 2), weights: new Float32Array([0.25, 0.5, 0.75]), count: 2 } } }));
        expect(longer.json.meshes[0].weights).toEqual([0.25, 0.5]);
        expect(firstPrimitive(longer).targets).toHaveLength(2);
    });
});

describe("skinned meshes", () => {
    it("warns and exports without JOINTS, WEIGHTS or skins", async () => {
        const glb = await exportMesh(createMesh("skinned", { extra: { skeleton: {} } }));
        expect(glb.warnings).toContain('Mesh "skinned" is skinned; skins are not exported, so it exports without skinning.');
        const attributes = firstPrimitive(glb).attributes;
        expect(attributes.JOINTS_0).toBeUndefined();
        expect(attributes.WEIGHTS_0).toBeUndefined();
        expect(glb.json.skins).toBeUndefined();
        expect(glb.json.nodes[0].skin).toBeUndefined();
        expect(attributes.POSITION).toBeDefined();
    });
});

describe("thin instances", () => {
    const translationMatrix = (x: number, y: number, z: number) => Array.from(composeMat4(x, y, z, 0, 0, 0, 1, 1, 1, 1) as unknown as ArrayLike<number>);
    const matrices = (...parts: number[][]) => new Float32Array(parts.flat());
    const instanced = (thin: Record<string, unknown>) => createMesh("inst", { extra: { thinInstances: thin } });

    function instancing(glb: ParsedGlb) {
        return glb.json.nodes[0].extensions.EXT_mesh_gpu_instancing.attributes;
    }

    it("exports converted TRANSLATION and omits ROTATION and SCALE when only translations deviate", async () => {
        const glb = await exportMesh(instanced({ matrices: matrices(translationMatrix(1, 2, 3), translationMatrix(-4, 0, 5)), count: 2 }));
        const attributes = instancing(glb);
        expect(Object.keys(attributes)).toEqual(["TRANSLATION"]);
        expect(glb.json.accessors[attributes.TRANSLATION]).toMatchObject({ type: "VEC3", count: 2, componentType: FLOAT });
        expectClose(readAccessor(glb, attributes.TRANSLATION), [-1, 2, 3, 4, 0, 5]);
        expect(glb.json.extensionsUsed).toContain("EXT_mesh_gpu_instancing");
        expect(glb.json.extensionsRequired).toBeUndefined();
    });

    it("exports converted ROTATION and SCALE when some instance deviates", async () => {
        // 60 degrees about +Y converts to (0, -0.5, 0, cos30).
        const rotated = Array.from(composeMat4(0, 0, 0, 0, 0.5, 0, Math.sqrt(3) / 2, 2, 3, 4) as unknown as ArrayLike<number>);
        const glb = await exportMesh(instanced({ matrices: matrices(translationMatrix(0, 0, 0), rotated), count: 2 }));
        const attributes = instancing(glb);
        expect(attributes.TRANSLATION).toBeUndefined();
        expectClose(readAccessor(glb, attributes.ROTATION), [0, 0, 0, 1, 0, -0.5, 0, Math.sqrt(3) / 2]);
        expectClose(readAccessor(glb, attributes.SCALE), [1, 1, 1, 2, 3, 4]);
        expect(glb.json.accessors[attributes.ROTATION].type).toBe("VEC4");
    });

    it("exports TRANSLATION for all-identity instances because the extension needs one attribute", async () => {
        const glb = await exportMesh(instanced({ matrices: matrices(translationMatrix(0, 0, 0), translationMatrix(0, 0, 0)), count: 2 }));
        const attributes = instancing(glb);
        expect(Object.keys(attributes)).toEqual(["TRANSLATION"]);
        expectClose(readAccessor(glb, attributes.TRANSLATION), [0, 0, 0, 0, 0, 0]);
    });

    it("exports _COLOR_0 as VEC3 and warns when some instance alpha is below 1", async () => {
        const colors = new Float32Array([1, 0, 0, 1, 0, 1, 0, 0.5]);
        const glb = await exportMesh(instanced({ matrices: matrices(translationMatrix(1, 0, 0), translationMatrix(2, 0, 0)), count: 2, colors }));
        const attributes = instancing(glb);
        expect(glb.json.accessors[attributes._COLOR_0]).toMatchObject({ type: "VEC3", count: 2 });
        expectClose(readAccessor(glb, attributes._COLOR_0), [1, 0, 0, 0, 1, 0]);
        expect(glb.warnings).toContain('Instance color alpha of mesh "inst" is not represented in _COLOR_0; exporting RGB.');
    });

    it("does not warn when every instance alpha is 1", async () => {
        const colors = new Float32Array([1, 0, 0, 1, 0, 1, 0, 1]);
        const glb = await exportMesh(instanced({ matrices: matrices(translationMatrix(1, 0, 0), translationMatrix(2, 0, 0)), count: 2, colors }));
        expect(instancing(glb)._COLOR_0).toBeDefined();
        expect(glb.warnings).toEqual([]);
    });

    it("exports instances verbatim in a pass-through pass", async () => {
        const mesh = instanced({ matrices: matrices(translationMatrix(1, 2, 3)), count: 1 });
        (mesh as { _authoredSign?: number })._authoredSign = -1;
        const glb = await exportPassThrough(mesh);
        expectClose(readAccessor(glb, instancing(glb).TRANSLATION), [1, 2, 3]);
    });

    it("skips the extension for a mesh with zero active instances", async () => {
        const glb = await exportMesh(instanced({ matrices: matrices(translationMatrix(1, 0, 0)), count: 0 }));
        expect(glb.json.nodes[0].extensions).toBeUndefined();
        expect(glb.json.extensionsUsed).toBeUndefined();
    });

    it("attaches the extension to the node that holds the folded mesh", async () => {
        const holder = createTransformNode("holder");
        const mesh = attach(instanced({ matrices: matrices(translationMatrix(1, 0, 0)), count: 1 }), holder);
        const glb = await exportAndParse(createScene({ meshes: [mesh] }));
        expect(glb.json.nodes).toHaveLength(1);
        expect(glb.json.nodes[0].extensions.EXT_mesh_gpu_instancing).toBeDefined();
    });
});
