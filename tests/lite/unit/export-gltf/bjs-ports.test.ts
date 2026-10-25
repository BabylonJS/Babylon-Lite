/** Ports of the Babylon.js glTF serializer unit tests that build a scene natively (meshes, sub meshes,
 *  morph targets) and export it. Each test keeps its Babylon.js title and values; the scenes are
 *  expressed in Lite's plain-data model. The tests that start from a hand-built glTF document run
 *  through the real loader in tests/lite/plumbing/export-gltf.spec.ts.
 *
 *  Lite has no sub meshes or multi-materials: a Babylon.js mesh with several sub meshes corresponds
 *  to a transform node whose child meshes each hold one material and one index range, exactly the
 *  shape the glTF loader builds. The exporter folds those children back into one glTF mesh. */

import { describe, expect, it } from "vitest";
import { attach, createFakeDevice, createMesh, createScene, createTexture, exportAndParse, readAccessor } from "./export-test-utils";
import type { ParsedGlb } from "./export-test-utils";
import { createPbrMaterial } from "../../../../packages/babylon-lite/src/material/pbr/pbr-material";
import { createDirectionalLight } from "../../../../packages/babylon-lite/src/light/directional-light";
import { createPointLight } from "../../../../packages/babylon-lite/src/light/point-light";
import { createSpotLight } from "../../../../packages/babylon-lite/src/light/spot-light";
import { setParent } from "../../../../packages/babylon-lite/src/scene/set-parent";
import { createTransformNode } from "../../../../packages/babylon-lite/src/scene/transform-node";
import { INTERP_LINEAR, INTERP_STEP, PATH_ROTATION, PATH_SCALE, PATH_TRANSLATION } from "../../../../packages/babylon-lite/src/animation/types";
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

describe("Babylon.js glTFSerializer.test.ts", () => {
    // Layout used for the expected counts (docs/lite/architecture/60-gltf-exporter.md, Geometry export and Determinism): one accessor and one
    // tightly packed bufferView per emitted array (POSITION, NORMAL, TEXCOORD_0, indices for the default mesh), one accessor and bufferView
    // each for an animation sampler's input and output, and no material members for a material-less mesh. Babylon.js counts differ because
    // it drops unused UVs and emits an extra bufferView.
    const GEOMETRY_ARRAYS = 4;

    it("should serialize sphere geometry in window.scene to glTF", async () => {
        const { json } = await exportAndParse(createScene({ meshes: [createMesh("sphere")] }));

        expect(Object.keys(json).sort()).toEqual(["accessors", "asset", "bufferViews", "buffers", "meshes", "nodes", "scene", "scenes"]);
        expect(json.accessors).toHaveLength(GEOMETRY_ARRAYS);
        expect(Object.keys(json.asset).sort()).toEqual(["generator", "version"]);
        expect(json.buffers).toHaveLength(1);
        expect(json.bufferViews).toHaveLength(GEOMETRY_ARRAYS);
        expect(json.meshes).toHaveLength(1);
        expect(json.nodes).toHaveLength(1);
        expect(json.scenes).toHaveLength(1);
        expect(json.scene).toEqual(0);
    });

    describe("animations", () => {
        const KEY_SECONDS = [0, 20 / 30, 40 / 30]; // Babylon.js frames 0, 20, 40 at 30 fps
        const BASE_ARRAYS = GEOMETRY_ARRAYS;

        function clipGroup(name: string, target: object, path: number, output: number[]): AnimationGroups[number] {
            const clip = {
                name,
                channels: [{ samplerIdx: 0, nodeIdx: 0, path }],
                samplers: [{ input: new Float32Array(KEY_SECONDS), output: new Float32Array(output), interpolation: INTERP_LINEAR }],
                duration: KEY_SECONDS[2],
            };
            return { name, targetedAnimations: [{ target, path: "position" }], _gltfMixer: [clip, [], []] } as unknown as AnimationGroups[number];
        }

        /** Assert the wiring Babylon.js asserts for one single-channel animation whose sampler input and output are accessors `input` and `input + 1`. */
        function expectAnimation(json: ParsedGlb["json"], bin: ParsedGlb, index: number, path: string, input: number, output: number[], components: "VEC3" | "VEC4"): void {
            const animation = json.animations[index];
            expect(animation.channels).toHaveLength(1);
            expect(animation.channels[0].sampler).toEqual(0);
            expect(animation.channels[0].target.node).toEqual(0);
            expect(animation.channels[0].target.path).toEqual(path);
            expect(animation.samplers).toHaveLength(1);
            expect(animation.samplers[0].interpolation).toBeUndefined(); // LINEAR is the glTF default and is omitted
            expect(animation.samplers[0].input).toEqual(input);
            expect(animation.samplers[0].output).toEqual(input + 1);
            expect(json.accessors[input]).toMatchObject({ componentType: 5126, count: 3, type: "SCALAR", min: [0] });
            expect(json.accessors[input].max[0]).toBeCloseTo(KEY_SECONDS[2]!, 6);
            expect(json.accessors[input + 1]).toMatchObject({ componentType: 5126, count: 3, type: components });
            expect(json.accessors[input + 1].min).toBeUndefined();
            expectValuesClose(readAccessor(bin, input), KEY_SECONDS);
            expectValuesClose(readAccessor(bin, input + 1), output);
        }

        function expectDocument(json: ParsedGlb["json"], animations: number): void {
            expect(Object.keys(json).sort()).toEqual(["accessors", "animations", "asset", "bufferViews", "buffers", "meshes", "nodes", "scene", "scenes"]);
            expect(Object.keys(json.asset)).toHaveLength(2);
            expect(json.accessors).toHaveLength(BASE_ARRAYS + 2 * animations);
            expect(json.bufferViews).toHaveLength(BASE_ARRAYS + 2 * animations);
            expect(json.buffers).toHaveLength(1);
            expect(json.meshes).toHaveLength(1);
            expect(json.nodes).toHaveLength(1);
            expect(json.scenes).toHaveLength(1);
            expect(json.scene).toEqual(0);
            expect(json.animations).toHaveLength(animations);
        }

        const translationKeys = [0.1, 0.1, 0.1, 1, 1, 1, 0.1, 0.1, 0.1];
        const rotationKeys = [0.707, 0, 0, 0.707, 0, 0, 0, 1, 0.707, 0, 0, 0.707];

        it("should serialize translation animation to glTF", async () => {
            const box = createMesh("box");
            const glb = await exportAndParse(createScene({ meshes: [box], animationGroups: [clipGroup("boxAnimation_translation", box, PATH_TRANSLATION, translationKeys)] }));

            expectDocument(glb.json, 1);
            // The converting pass negates X of translation values.
            expectAnimation(
                glb.json,
                glb,
                0,
                "translation",
                BASE_ARRAYS,
                translationKeys.map((v, i) => (i % 3 === 0 ? -v : v)),
                "VEC3"
            );
        });

        it("should serialize scale animation to glTF", async () => {
            const box = createMesh("box");
            const glb = await exportAndParse(createScene({ meshes: [box], animationGroups: [clipGroup("boxAnimation_scale", box, PATH_SCALE, translationKeys)] }));

            expectDocument(glb.json, 1);
            expectAnimation(glb.json, glb, 0, "scale", BASE_ARRAYS, translationKeys, "VEC3");
        });

        it("should serialize rotation quaternion animation to glTF", async () => {
            const box = createMesh("box");
            const glb = await exportAndParse(createScene({ meshes: [box], animationGroups: [clipGroup("boxAnimation_rotation", box, PATH_ROTATION, rotationKeys)] }));

            expectDocument(glb.json, 1);
            // The converting pass maps (x, y, z, w) to (x, -y, -z, w); these keys have y = z = 0.
            expectAnimation(glb.json, glb, 0, "rotation", BASE_ARRAYS, rotationKeys, "VEC4");
        });

        // Babylon.js attaches two Animation objects to one mesh and exports two glTF animations. Lite animates through clip groups, so the
        // same node gets two single-channel groups (rotation, then scale), each with its own sampler arrays.
        it("should serialize combined animations to glTF", async () => {
            const box = createMesh("box");
            const glb = await exportAndParse(
                createScene({
                    meshes: [box],
                    animationGroups: [clipGroup("boxAnimation_rotation", box, PATH_ROTATION, rotationKeys), clipGroup("boxAnimation_scale", box, PATH_SCALE, translationKeys)],
                })
            );

            expectDocument(glb.json, 2);
            expectAnimation(glb.json, glb, 0, "rotation", BASE_ARRAYS, rotationKeys, "VEC4");
            expectAnimation(glb.json, glb, 1, "scale", BASE_ARRAYS + 2, translationKeys, "VEC3");
        });
    });

    describe("lights", () => {
        const RED: [number, number, number] = [1, 0, 0];

        // Lite never exports innerConeAngle (spec, Light export: it stays at the schema default), so it is asserted absent.
        it("should serialize spot light to glTF", async () => {
            const intensity = 0.2;
            const angle = Math.PI / 4;
            const spot = createSpotLight([-4, 4, 0], [0, angle, 0], angle, 2, intensity);
            spot.diffuse = RED;

            const glb = await exportAndParse(createScene({ lights: [spot] }));

            expect(Object.keys(glb.json).sort()).toEqual(["asset", "extensions", "extensionsUsed", "nodes", "scene", "scenes"]);
            expect(glb.json.extensions.KHR_lights_punctual.lights).toHaveLength(1);
            const light = glb.json.extensions.KHR_lights_punctual.lights[0];
            expect(light.type).toEqual("spot");
            expect(light.intensity).toEqual(intensity);
            expect(light.color).toEqual(RED);
            expect(light.spot.outerConeAngle).toEqual(angle / 2);
            expect(light.spot.innerConeAngle).toBeUndefined();
            expect(glb.json.nodes).toHaveLength(1);
            expect(glb.json.nodes[0].extensions.KHR_lights_punctual.light).toEqual(0);
        });

        it("should serialize multiple lights to glTF", async () => {
            const point = createPointLight([4, 4, 0]);
            const spot = createSpotLight([-4, 4, 0], [0, Math.PI / 4, 0], Math.PI / 4, 2);
            const directional = createDirectionalLight([0, 0, 1]);

            const glb = await exportAndParse(createScene({ lights: [point, spot, directional] }));

            expect(Object.keys(glb.json).sort()).toEqual(["asset", "extensions", "extensionsUsed", "nodes", "scene", "scenes"]);
            expect(glb.json.extensions.KHR_lights_punctual.lights.map((l: { type: string }) => l.type)).toEqual(["point", "spot", "directional"]);
            expect(glb.json.nodes).toHaveLength(3);
            expect(glb.json.nodes.map((n: { extensions: { KHR_lights_punctual: { light: number } } }) => n.extensions.KHR_lights_punctual.light)).toEqual([0, 1, 2]);
        });
    });

    // Adapted: SceneContext carries no metadata, so the scene-level extras assertion is dropped (spec: scene-level extras are out of scope).
    it("serializes scene and node metadata", async () => {
        const box = createMesh("box");
        box.metadata = { test: "test" };
        const box2 = createMesh("box2");
        box2.metadata = { gltf: { extras: { foo: 2, bar: "baz" } } };

        const { json } = await exportAndParse(createScene({ meshes: [box, box2] }));

        const node1 = json.nodes.find((node: { name: string }) => node.name === "box");
        const node2 = json.nodes.find((node: { name: string }) => node.name === "box2");
        expect(node1).toBeDefined();
        expect(node1.extras).toBeUndefined();
        expect(node2).toBeDefined();
        expect(node2.extras).toBeDefined();
        expect(node2.extras.foo).toEqual(2);
        expect(node2.extras.bar).toEqual("baz");
    });

    describe("exporting instances", () => {
        // Lite shares a glTF mesh between same-named nodes that share geometry arrays and material (the shape the loader gives instanced
        // nodes), so the instances carry the source's name. Differently named instances would export as separate glTF meshes over shared accessors.
        const positions = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
        const normals = new Float32Array([0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1]);
        const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
        const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
        const instanceCount = 3;

        it("can export instances without their source mesh", async () => {
            const material = createPbrMaterial({});
            const source = createMesh("box", { positions, normals, uvs, indices, material });
            const scene = createScene({ meshes: [source] });
            for (let i = 0; i < instanceCount; i++) {
                const instance = createMesh("box", { positions, normals, uvs, indices, material });
                instance.position.set(i + 1, 0, 0);
                scene.meshes.push(instance);
            }
            // removeFromScene takes the source out of scene.meshes.
            scene.meshes.splice(scene.meshes.indexOf(source), 1);

            const { json } = await exportAndParse(scene);

            expect(json.nodes).toHaveLength(instanceCount);
            expect(json.meshes).toHaveLength(1);
            for (const node of json.nodes) {
                expect(node.mesh).toEqual(0);
            }
        });
    });

    it("should not convert right-handed node transformations", async () => {
        const transformsRH = {
            translation: [0.2, 0.3, 0.4],
            scale: [0.5, 0.6, 0.7],
            rotation: [0.5, 0.5, 0.5, 0.5],
        };
        // Right-handed data lives under the glTF loader's conversion root, which the exporter strips (pass-through state).
        const root = createTransformNode("__root__", 0, 0, 0, 0, 0, 0, 1, -1, 1, 1);
        const place = (mesh: ReturnType<typeof createMesh>) => {
            mesh.position.set(transformsRH.translation[0]!, transformsRH.translation[1]!, transformsRH.translation[2]!);
            mesh.scaling.set(transformsRH.scale[0]!, transformsRH.scale[1]!, transformsRH.scale[2]!);
            mesh.rotationQuaternion.set(transformsRH.rotation[0]!, transformsRH.rotation[1]!, transformsRH.rotation[2]!, transformsRH.rotation[3]!);
            return mesh;
        };
        const parent = attach(place(createMesh("box")), root);
        const child = attach(place(createMesh("child")), parent);

        const { json } = await exportAndParse(createScene({ meshes: [parent, child] }));

        expect(json.nodes).toHaveLength(2);
        expect(json.scenes[0].nodes).toEqual([0]);
        expect(json.nodes[0].children).toEqual([1]);
        json.nodes.forEach((node: { translation: number[]; scale: number[]; rotation: number[] }) => {
            expect(node.translation).toEqual(transformsRH.translation);
            expect(node.scale).toEqual(transformsRH.scale);
            expect(node.rotation).toEqual(transformsRH.rotation);
        });
    });

    // Adapted: removeFromScene removes a node together with its descendants, so a node's children survive its removal only after being
    // reparented with setParent (which keeps their world transform). Children of a node that is merely taken out of the scene would still
    // pull that node into the export through their parent chain.
    it("should reparent children of unexported node to nearest ancestor", async () => {
        // The Babylon.js scenario: parent > child > grandchild1, grandchild2, exporting only the grandchildren, which become scene roots.
        const parent = createMesh("parent");
        parent.position.set(1, 0, 0);
        const child = attach(createMesh("child"), parent);
        child.position.set(0, 2, 0);
        const grandchildren = [3, -3].map((z, i) => {
            const grandchild = attach(createMesh(`grandchild${i + 1}`), child);
            grandchild.position.set(0, 0, z);
            return grandchild;
        });
        for (const grandchild of grandchildren) {
            setParent(grandchild, null);
        }
        const scene = createScene({ meshes: [parent, child, ...grandchildren] });
        scene.meshes.splice(0, 2); // removeFromScene(parent) drops parent and child

        const roots = await exportAndParse(scene);

        expect(roots.json.nodes).toHaveLength(2);
        expect(roots.json.nodes[0].name).toContain("grandchild");
        expect(roots.json.nodes[1].name).toContain("grandchild");
        expect(roots.json.scenes).toHaveLength(1);
        expect(roots.json.scenes[0].nodes).toHaveLength(2);
        expect(roots.json.scenes[0].nodes).toContain(0);
        expect(roots.json.scenes[0].nodes).toContain(1);
        // World transforms are preserved: the mirror in the converting pass gives x = -1; the node carries them in `matrix` (setParent keeps an exact local matrix).
        expect(roots.json.nodes.map((n: { matrix: number[] }) => n.matrix.slice(12, 15))).toEqual([
            [-1, 2, 3],
            [-1, 2, -3],
        ]);

        // With an exported ancestor, the grandchild is reparented to that nearest ancestor instead.
        const kept = createMesh("kept");
        kept.position.set(0, 5, 0);
        const middle = attach(createMesh("middle"), kept);
        middle.position.set(4, 0, 0);
        const leaf = attach(createMesh("leaf"), middle);
        leaf.position.set(0, 0, 1);
        setParent(leaf, kept);
        const nested = createScene({ meshes: [kept, leaf] });
        middle.parent = null; // removeFromScene detaches the removed node

        const tree = await exportAndParse(nested);

        expect(tree.json.nodes.map((n: { name: string }) => n.name)).toEqual(["kept", "leaf"]);
        expect(tree.json.scenes[0].nodes).toEqual([0]);
        expect(tree.json.nodes[0].children).toEqual([1]);
        expect(tree.json.nodes[1].matrix.slice(12, 15)).toEqual([-4, 0, 1]);
    });

    // Adapted: Lite exports no KHR_texture_basisu. A compressed texture is decoded by the GPU blit and exported as PNG.
    it("uses KHR_texture_basisu to export a KTX2 image", async () => {
        const { device, stats } = createFakeDevice();
        const pixels = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
        const texture = createTexture(2, 2, pixels, { format: "bc7-rgba-unorm", usage: GPUTextureUsage.TEXTURE_BINDING, invertY: false });
        const material = createPbrMaterial({ baseColorTexture: texture, metallicFactor: 0, roughnessFactor: 1 });

        const glb = await exportAndParse(createScene({ meshes: [createMesh("plane", { material })], device }));

        expect(stats.blits).toBe(1);
        expect(glb.json.textures).toHaveLength(1);
        expect(glb.json.textures[0].extensions).toBeUndefined();
        const image = glb.json.images[glb.json.textures[0].source];
        expect(image).toBeDefined();
        expect(image.mimeType).toEqual("image/png");
        expect(glb.json.extensionsUsed ?? []).not.toContain("KHR_texture_basisu");
        expect(glb.json.extensionsUsed ?? []).not.toContain("EXT_texture_webp");
    });
});
