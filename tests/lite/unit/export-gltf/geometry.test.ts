import { describe, expect, it } from "vitest";
import { attach, createMesh, createScene, expectClose, exportAndParse, loaderRoot, readAccessor, reloadUntexturedGlb } from "./export-test-utils";
import type { FakeMeshOptions, ParsedGlb } from "./export-test-utils";
import { createTransformNode } from "../../../../packages/babylon-lite/src/scene/transform-node";
import { composeMat4 } from "../../../../packages/babylon-lite/src/math/compose-mat4";
import type { Mesh } from "../../../../packages/babylon-lite/src/mesh/mesh";

function exportMesh(mesh: Mesh, passThrough = false): Promise<ParsedGlb> {
    if (passThrough) {
        attach(mesh, loaderRoot());
    }
    return exportAndParse(createScene({ meshes: [mesh] }));
}

const firstPrimitive = (glb: ParsedGlb) => glb.json.meshes[0].primitives[0];
const instanced = (thinInstances: Record<string, unknown>) => createMesh("inst", { extra: { thinInstances } });
const instancing = (glb: ParsedGlb) => glb.json.nodes[0].extensions.EXT_mesh_gpu_instancing.attributes;
const identity = () => Array.from(composeMat4(0, 0, 0, 0, 0, 0, 1, 1, 1, 1));

describe("geometry", () => {
    it.each([false, true])("exports normalized vertex frames, bounds, UVs and colors without mutation (pass-through: %s)", async (passThrough) => {
        const positions = new Float32Array([1, -1, 0.5, 2, 3, 0.25, 3, 2, -2]);
        const normals = new Float32Array([2, 0, 0, 0, 3, 0, 1, 1, 0]);
        const tangents = new Float32Array([2, 0, 0, 1, 0, 3, 0, -1, 0, 0, 0, 1]);
        const uvs = new Float32Array([0, 0, 1, 0, 0, 1]);
        const colors = new Float32Array([1, 0.5, 0.25, 1, 0, 0, 0, 0.5, 1, 1, 1, 1]);
        const before = [positions, normals, tangents, uvs, colors].map((array) => Array.from(array));
        const glb = await exportMesh(createMesh("m", { positions, normals, tangents, uvs, uv2s: uvs, colors, indices: new Uint32Array([0, 1, 2]) }), passThrough);
        const attributes = firstPrimitive(glb).attributes;
        const sign = passThrough ? 1 : -1;
        expectClose(readAccessor(glb, attributes.POSITION), [sign, -1, 0.5, sign * 2, 3, 0.25, sign * 3, 2, -2]);
        expectClose(readAccessor(glb, attributes.NORMAL), [sign, 0, 0, 0, 1, 0, sign * Math.SQRT1_2, Math.SQRT1_2, 0]);
        expectClose(readAccessor(glb, attributes.TANGENT), [sign, 0, 0, sign, 0, 1, 0, -sign, 0, 0, 0, sign]);
        expect(glb.json.accessors[attributes.POSITION]).toMatchObject({ min: [passThrough ? 1 : -3, -1, -2], max: [passThrough ? 3 : -1, 3, 0.5] });
        expect(readAccessor(glb, attributes.TEXCOORD_0)).toEqual(Array.from(uvs));
        expect(readAccessor(glb, attributes.TEXCOORD_1)).toEqual(Array.from(uvs));
        expect(readAccessor(glb, attributes.COLOR_0)).toEqual(Array.from(colors));
        expect([positions, normals, tangents, uvs, colors].map((array) => Array.from(array))).toEqual(before);
    });

    it.each<{ name: string; options: FakeMeshOptions; absent: string[]; warnings: number }>([
        { name: "flat normals", options: { extra: { _flatNormal: true } }, absent: ["NORMAL"], warnings: 0 },
        { name: "GPU-only", options: { gpuOnly: ["tangent", "uv2", "color"] }, absent: ["TANGENT", "TEXCOORD_1", "COLOR_0"], warnings: 3 },
        { name: "missing", options: { normals: null, uvs: null }, absent: ["NORMAL", "TEXCOORD_0"], warnings: 0 },
        { name: "malformed", options: { normals: new Float32Array(9), uv2s: new Float32Array(4) }, absent: ["NORMAL", "TEXCOORD_1"], warnings: 2 },
    ])("omits $name attributes", async ({ options, absent, warnings }) => {
        const glb = await exportMesh(createMesh("m", options));
        for (const attribute of absent) {
            expect(firstPrimitive(glb).attributes[attribute]).toBeUndefined();
        }
        expect(firstPrimitive(glb).attributes.POSITION).toBeDefined();
        expect(glb.warnings).toHaveLength(warnings);
    });

    it.each([
        ["cpu", 65534, 5123],
        ["cpu", 65535, 5125],
        ["uint16", 65534, 5123],
        ["uint16", 65535, 5125],
        ["uint32", 2, 5125],
    ] as const)("preserves index values and restart-safe width (%s, %s)", async (kind, last, componentType) => {
        const values = [0, 1, 2, 0, 2, last];
        const gpuIndices = kind === "cpu" ? undefined : kind === "uint16" ? new Uint16Array(values) : new Uint32Array(values);
        const glb = await exportMesh(createMesh("m", { indices: new Uint32Array(gpuIndices ? [3, 3, 3] : values), gpuIndices }));
        expect(glb.json.accessors[firstPrimitive(glb).indices].componentType).toBe(componentType);
        expect(readAccessor(glb, firstPrimitive(glb).indices)).toEqual(values);
    });

    it.each([
        [false, 1, [0, 1, 2]],
        [false, -1, [0, 2, 1]],
        [true, -1, [0, 1, 2]],
        [true, 1, [0, 2, 1]],
    ] as const)("uses authored winding in either handedness pass (%s, %s)", async (passThrough, authoredSign, expected) => {
        const gpuIndices = new Uint16Array([0, 1, 2]);
        const glb = await exportMesh(createMesh("m", { authoredSign, gpuIndices }), passThrough);
        expect(readAccessor(glb, firstPrimitive(glb).indices)).toEqual(expected);
        expect(Array.from(gpuIndices)).toEqual([0, 1, 2]);
    });

    it.each([
        { name: "indexed strip", topology: 4, indices: [0, 1, 2, 3, 1], expected: [0, 2, 1, 2, 3, 1, 2, 1, 3] },
        { name: "non-indexed strip", topology: 4, indices: null, expected: [0, 2, 1, 2, 3, 1] },
        { name: "non-indexed triangles", topology: 0, indices: null, expected: [0, 2, 1, 3, 5, 4] },
        { name: "short strip", topology: 4, indices: [0, 1], expected: [] },
    ])("reverses a $name without mutating source indices", async ({ topology, indices, expected }) => {
        const source = indices === null ? null : new Uint32Array(indices);
        const positions = topology === 0 ? new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 2, 1, 0]) : undefined;
        const glb = await exportMesh(createMesh("m", { positions, normals: null, uvs: null, authoredSign: -1, indices: source, extra: { _topology: topology } }));
        expect(glb.json.nodes).toHaveLength(1);
        if (expected.length) {
            expect(firstPrimitive(glb).mode).toBeUndefined();
            expect(readAccessor(glb, firstPrimitive(glb).indices)).toEqual(expected);
        }
        expect(source === null ? null : Array.from(source)).toEqual(indices);
    });

    it.each([
        ["point-list", 0],
        ["line-list", 1],
        ["line-strip", 3],
        ["triangle-strip", 5],
    ] as const)("preserves %s topology without reversing indices", async (topology, mode) => {
        const glb = await exportMesh(createMesh("m", { authoredSign: topology === "triangle-strip" ? 1 : -1, extra: { _primitive: { topology } } }));
        expect(firstPrimitive(glb).mode).toBe(mode);
        expect(readAccessor(glb, firstPrimitive(glb).indices)).toEqual([0, 1, 2, 0, 2, 3]);
    });

    it.each<FakeMeshOptions>([{ indices: new Uint32Array(0) }, { positions: new Float32Array(0), normals: null, uvs: null }, { extra: { _cpuPositions: undefined } }])(
        "keeps an empty geometry node without a drawable mesh",
        async (options) => {
            const glb = await exportMesh(createMesh("m", options));
            expect(glb.json.nodes).toEqual([{ name: "m" }]);
            expect(glb.json.meshes).toBeUndefined();
        }
    );
});

describe("morph targets", () => {
    it.each([
        [false, true, [0.5], [0.5, 0]],
        [true, true, [0.25, 0.5, 0.75], [0.25, 0.5]],
        [false, false, [1, 0], [1, 0]],
    ] as const)("keeps shared POSITION/NORMAL bounds, deltas and target-sized weights (%s, %s)", async (passThrough, baseNormals, weights, expectedWeights) => {
        const shared = new Float32Array(12).fill(0.5);
        const positions = new Float32Array([1, 0, 0, 2, 1, 0, -3, 0, 1, 0.5, 0.5, 0.5]);
        const targets = [
            { positions, normals: shared },
            { positions: shared, normals: null },
        ];
        const glb = await exportMesh(
            createMesh("m", {
                normals: baseNormals ? undefined : null,
                extra: { morphTargets: { targets, weights: new Float32Array(weights), count: 2 } },
            }),
            passThrough
        );
        const exported = firstPrimitive(glb).targets;
        const sign = passThrough ? 1 : -1;
        expectClose(readAccessor(glb, exported[0].POSITION), [sign, 0, 0, sign * 2, 1, 0, sign * -3, 0, 1, sign * 0.5, 0.5, 0.5]);
        expect(glb.json.accessors[exported[1].POSITION]).toMatchObject({ min: [sign * 0.5, 0.5, 0.5], max: [sign * 0.5, 0.5, 0.5] });
        expect(exported[1].POSITION).not.toBe(exported[0].NORMAL);
        if (baseNormals) {
            expectClose(
                readAccessor(glb, exported[0].NORMAL),
                Array.from({ length: 12 }, (_, index) => (index % 3 === 0 ? sign * 0.5 : 0.5))
            );
        } else {
            expect(exported[0].NORMAL).toBeUndefined();
        }
        expect(glb.json.meshes[0].weights).toEqual(expectedWeights);
    });

    it("drops all targets and weights when just one target has malformed positions", async () => {
        const targets = [12, 9].map((length) => ({ positions: new Float32Array(length), normals: null }));
        const glb = await exportMesh(createMesh("m", { extra: { morphTargets: { targets, weights: new Float32Array([0.5, 0.5]), count: 2 } } }));
        expect(firstPrimitive(glb).targets).toBeUndefined();
        expect(glb.json.meshes[0].weights).toBeUndefined();
        expect(glb.warnings).toEqual(['Mesh "m" has morph targets whose length does not match its positions; exporting the mesh without them.']);
    });

    it("exports skinned geometry without skinning and warns", async () => {
        const glb = await exportMesh(createMesh("skinned", { extra: { skeleton: {} } }));
        expect(firstPrimitive(glb).attributes.JOINTS_0).toBeUndefined();
        expect(firstPrimitive(glb).attributes.WEIGHTS_0).toBeUndefined();
        expect(glb.json.skins).toBeUndefined();
        expect(glb.warnings).toContain('Mesh "skinned" is skinned; skins are not exported, so it exports without skinning.');
    });
});

describe("thin instances", () => {
    it("round-trips colored identity-instance count, ignoring spare capacity and warning about alpha", async () => {
        const matrices = new Float32Array([...identity(), ...identity(), ...identity()]);
        const colors = new Float32Array([1, 0, 0, 1, 0, 1, 0, 0.5, 0, 0, 1, 1]);
        const glb = await exportMesh(instanced({ matrices, count: 2, colors }));
        const container = await reloadUntexturedGlb(glb);
        const mesh = container.entities[0]!.children[0]!.children[0] as Mesh;
        expect(mesh.thinInstances?.count).toBe(2);
        expectClose(mesh.thinInstances?.matrices, Array.from(matrices.subarray(0, 32)));
        expectClose(readAccessor(glb, instancing(glb)._COLOR_0), [1, 0, 0, 0, 1, 0]);
        expectClose(readAccessor(glb, instancing(glb).TRANSLATION), [0, 0, 0, 0, 0, 0]);
        expect(instancing(glb).ROTATION).toBeUndefined();
        expect(instancing(glb).SCALE).toBeUndefined();
        expect(glb.warnings).toContain('Instance color alpha of mesh "inst" is not represented in _COLOR_0; exporting RGB.');
    });

    it.each([false, true])("preserves all small instance TRS components on reload (pass-through: %s)", async (passThrough) => {
        const qy = 0.0005;
        const qw = Math.sqrt(1 - qy * qy);
        const matrices = new Float32Array(composeMat4(0.0005, 0, 0, 0, qy, 0, qw, 1.0005, 1, 1));
        const glb = await exportMesh(instanced({ matrices, count: 1 }), passThrough);
        const container = await reloadUntexturedGlb(glb);
        const mesh = container.entities[0]!.children[0]!.children[0] as Mesh;
        const sign = passThrough ? 1 : -1;
        expectClose(mesh.thinInstances?.matrices, Array.from(composeMat4(sign * 0.0005, 0, 0, 0, sign * qy, 0, qw, 1.0005, 1, 1)), 6);
    });

    it("round-trips a zero-active pool as a hierarchy node without a drawable mesh", async () => {
        const mesh = instanced({ matrices: new Float32Array(identity()), count: 0 });
        attach(createTransformNode("marker", 1, 2, 3), mesh);
        const glb = await exportMesh(mesh);
        expect(glb.json.nodes[0].mesh).toBeUndefined();
        expect(glb.json.meshes).toBeUndefined();
        expect(glb.json.extensionsUsed).toBeUndefined();
        const container = await reloadUntexturedGlb(glb);
        const reloaded = container.entities[0]!.children[0]!;
        expect(reloaded.name).toBe("inst");
        expect("material" in reloaded).toBe(false);
        expect(reloaded.children.map((child) => child.name)).toEqual(["marker"]);
    });

    it("omits a zero-active pool's primitive when folded beside an ordinary mesh", async () => {
        const holder = createTransformNode("holder");
        const empty = attach(instanced({ matrices: new Float32Array(identity()), count: 0 }), holder);
        const visible = attach(createMesh("visible"), holder);
        const glb = await exportAndParse(createScene({ meshes: [empty, visible] }));
        expect(glb.json.meshes).toHaveLength(1);
        expect(glb.json.meshes[0].primitives).toHaveLength(1);
        const container = await reloadUntexturedGlb(glb);
        const reloaded = container.entities[0]!.children[0]!;
        expect(reloaded.name).toBe("holder");
        expect(reloaded.children).toHaveLength(1);
        expect("material" in reloaded.children[0]!).toBe(true);
    });
});
