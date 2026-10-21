/** Ports of the Babylon.js glTF serializer unit tests that build a scene natively (meshes, sub meshes,
 *  morph targets) and export it. Each test keeps its Babylon.js title and values; the scenes are
 *  expressed in Lite's plain-data model. The tests that start from a hand-built glTF document run
 *  through the real loader in tests/lite/plumbing/export-gltf-bjs-ports.spec.ts.
 *
 *  Lite has no sub meshes or multi-materials: a Babylon.js mesh with several sub meshes corresponds
 *  to a transform node whose child meshes each hold one material and one index range, exactly the
 *  shape the glTF loader builds. The exporter folds those children back into one glTF mesh. */

import { describe, expect, it } from "vitest";
import { attach, createMesh, createScene, exportAndParse, readAccessor } from "./export-test-utils";
import { createPbrMaterial } from "../../../../packages/babylon-lite/src/material/pbr/pbr-material";
import { createTransformNode } from "../../../../packages/babylon-lite/src/scene/transform-node";
import { INTERP_LINEAR, INTERP_STEP, PATH_SCALE, PATH_TRANSLATION } from "../../../../packages/babylon-lite/src/animation/types";
import type { SceneContext } from "../../../../packages/babylon-lite/src/scene/scene-core";

type AnimationGroups = SceneContext["animationGroups"];

function expectValuesClose(actual: number[], expected: number[]): void {
    expect(actual).toHaveLength(expected.length);
    actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index]!, 5));
}

/** A transform node with two child meshes, one per "sub mesh", sharing one vertex array. The first
 *  draws vertices 0..2 and the second vertices 3..5 through offset index ranges. */
function createTwoSubMeshes(name: string, positions: Float32Array, materialNames: [string, string], extra: Record<string, unknown> = {}) {
    const node = createTransformNode(name);
    const meshes = [new Uint32Array([0, 1, 2]), new Uint32Array([3, 4, 5])].map((indices, i) => {
        const material = createPbrMaterial();
        material.name = materialNames[i]!;
        return attach(createMesh(`${name}_${i}`, { positions, normals: null, uvs: null, indices, material, extra }), node);
    });
    return { node, meshes };
}

describe("Babylon.js glTFExporter.test.ts", () => {
    it("writes a binary glTF with a JSON chunk followed by a BIN chunk", async () => {
        // Babylon.js also checks that the result holds the single file "model.glb"; Lite returns one Blob.
        const { bytes, json } = await exportAndParse(createScene({ meshes: [createMesh("box")] }));

        const glb = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        expect(glb.getUint32(0, true)).toBe(0x46546c67); // "glTF"
        expect(glb.getUint32(4, true)).toBe(2);
        expect(glb.getUint32(8, true)).toBe(glb.byteLength);

        const jsonLength = glb.getUint32(12, true);
        expect(glb.getUint32(16, true)).toBe(0x4e4f534a); // "JSON"
        expect(jsonLength % 4).toBe(0);

        const binHeader = 20 + jsonLength;
        const binLength = glb.getUint32(binHeader, true);
        expect(glb.getUint32(binHeader + 4, true)).toBe(0x004e4942); // "BIN\0"
        expect(binLength % 4).toBe(0);
        expect(binHeader + 8 + binLength).toBe(glb.byteLength);

        expect(json.buffers[0].uri).toBeUndefined();
        expect(json.buffers[0].byteLength).toBeLessThanOrEqual(binLength);
    });

    // Adapted: Lite has no shouldExportNode predicate; the caller restructures the scene instead, and
    // removeFromScene takes a mesh out of scene.meshes (the exporter's seed list).
    it("exports only the nodes accepted by shouldExportNode", async () => {
        const kept = createMesh("kept");
        const skipped = createMesh("skipped");
        skipped.position.set(1, 0, 0);
        const scene = createScene({ meshes: [kept, skipped] });
        scene.meshes.splice(scene.meshes.indexOf(skipped), 1);

        const gltf = await exportAndParse(scene);

        expect(gltf.json.nodes.map((n: { name: string }) => n.name)).toEqual([kept.name]);
    });

    // https://forum.babylonjs.com/t/multi-materials-cause-strange-glb-export-artifacts/60558 (fixed by https://github.com/BabylonJS/Babylon.js/pull/17241)
    // https://forum.babylonjs.com/t/exporting-to-gltf-in-new-version-causing-an-error-on-importing-from-blender/62030 (fixed by https://github.com/BabylonJS/Babylon.js/pull/17662)
    it("preserves geometry and material for sub meshes with offset vertex and index ranges", async () => {
        const sourcePositions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 2, 1, 0]);
        const { meshes } = createTwoSubMeshes("mesh", sourcePositions, ["a", "b"]);

        const gltf = await exportAndParse(createScene({ meshes }));

        const primitives = gltf.json.meshes[0].primitives;
        expect(gltf.json.meshes).toHaveLength(1);
        expect(primitives).toHaveLength(2);
        const actual = primitives.map((primitive: { attributes: { POSITION: number }; indices?: number; material?: number }) => {
            const positions = readAccessor(gltf, primitive.attributes.POSITION);
            const indices = primitive.indices === undefined ? Array.from({ length: positions.length / 3 }, (_, index) => index) : readAccessor(gltf, primitive.indices);
            const corners = indices.map((index) => positions.slice(index * 3, index * 3 + 3).join(",")).sort();
            const material = primitive.material === undefined ? undefined : gltf.json.materials[primitive.material];
            if (!material) {
                throw new Error("Expected a material for every exported sub mesh");
            }
            return { material: material.name, corners };
        });
        expect(actual).toEqual([
            { material: "a", corners: ["0,0,0", "0,1,0", "-1,0,0"].sort() },
            { material: "b", corners: ["-2,0,0", "-2,1,0", "-3,0,0"].sort() },
        ]);
    });
});

describe("Babylon.js glTFAnimation.test.ts", () => {
    /** A clip group animating `target` with translation (STEP) and scale (LINEAR) channels, as in the Babylon.js asset. */
    function createMoveGroup(target: object): AnimationGroups[number] {
        const input = new Float32Array([0, 0.5, 1]);
        const clip = {
            name: "move",
            channels: [
                { samplerIdx: 0, nodeIdx: 0, path: PATH_TRANSLATION },
                { samplerIdx: 1, nodeIdx: 0, path: PATH_SCALE },
            ],
            samplers: [
                { input, output: new Float32Array([0, 0, 0, 1, 0, 0, 1, 2, 0]), interpolation: INTERP_STEP },
                { input, output: new Float32Array([1, 1, 1, 2, 2, 2, 3, 3, 3]), interpolation: INTERP_LINEAR },
            ],
            duration: 1,
        };
        return {
            name: "move",
            targetedAnimations: [
                { target, path: "position" },
                { target, path: "scaling" },
            ],
            _gltfMixer: [clip, [], []],
        } as unknown as AnimationGroups[number];
    }

    // Adapted: Lite has no shouldExportAnimation predicate; the exporter writes the groups in scene.animationGroups,
    // so taking a group out of that list excludes it.
    it("exports only the animations accepted by shouldExportAnimation", async () => {
        const triangle = createMesh("triangle");
        const scene = createScene({ meshes: [triangle], animationGroups: [createMoveGroup(triangle)] });
        expect((await exportAndParse(scene)).json.animations).toHaveLength(1);

        scene.animationGroups.length = 0;
        const gltf = await exportAndParse(scene);

        expect(gltf.json.animations).toBeUndefined();
        expect(gltf.json.nodes.map((n: { name: string }) => n.name)).toEqual(["triangle"]);
    });
});

describe("Babylon.js glTFSkinsAndMorphTargets.test.ts", () => {
    it("exports morph target deltas on each sub mesh primitive", async () => {
        const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 2, 1, 0]);
        // Lite morph targets hold deltas from the base positions, not absolute positions: vertex v moves up by
        // 0.25 * v plus 0.5 for the first target and 0.25 for the second.
        const deltas = (base: number) => Float32Array.from({ length: 18 }, (_, index) => (index % 3 === 1 ? Math.floor(index / 3) * 0.25 + base : 0));
        const morphTargets = {
            targets: [
                { positions: deltas(0.5), normals: null },
                { positions: deltas(0.25), normals: null },
            ],
            weights: new Float32Array([0.25, 0.75]),
            count: 2,
        };
        const { meshes } = createTwoSubMeshes("morphed", positions, ["first", "second"], { morphTargets });

        const gltf = await exportAndParse(createScene({ meshes }));

        const primitives = gltf.json.meshes[0].primitives;
        expect(primitives).toHaveLength(2);
        expect(gltf.json.meshes[0].weights).toEqual([0.25, 0.75]);
        for (const primitive of primitives) {
            expect(primitive.targets).toHaveLength(2);
            const [first, second] = primitive.targets;
            if (first.POSITION === undefined || second.POSITION === undefined) {
                throw new Error("Expected exported position morph targets");
            }
            expect(gltf.json.accessors[first.POSITION].count).toBe(gltf.json.accessors[primitive.attributes.POSITION].count);
            expect(gltf.json.accessors[second.POSITION].count).toBe(gltf.json.accessors[primitive.attributes.POSITION].count);
            expectValuesClose(readAccessor(gltf, first.POSITION), [0, 0.5, 0, 0, 0.75, 0, 0, 1, 0, 0, 1.25, 0, 0, 1.5, 0, 0, 1.75, 0]);
            expectValuesClose(readAccessor(gltf, second.POSITION), [0, 0.25, 0, 0, 0.5, 0, 0, 0.75, 0, 0, 1, 0, 0, 1.25, 0, 0, 1.5, 0]);
        }
    });
});
