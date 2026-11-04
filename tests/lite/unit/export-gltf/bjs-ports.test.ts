/** Native-scene adaptations of Babylon.js serializers/test. Loader-based ports stay in plumbing. */
import { describe, expect, it } from "vitest";
import { attach, createMesh, createScene, expectClose, exportAndParse, loaderRoot, readAccessor } from "./export-test-utils";
import { createPbrMaterial } from "../../../../packages/babylon-lite/src/material/pbr/pbr-material";
import { createDirectionalLight } from "../../../../packages/babylon-lite/src/light/directional-light";
import { createPointLight } from "../../../../packages/babylon-lite/src/light/point-light";
import { createSpotLight } from "../../../../packages/babylon-lite/src/light/spot-light";
import { setParent } from "../../../../packages/babylon-lite/src/scene/set-parent";
import { createTransformNode } from "../../../../packages/babylon-lite/src/scene/transform-node";
import { INTERP_LINEAR, PATH_ROTATION, PATH_SCALE, PATH_TRANSLATION } from "../../../../packages/babylon-lite/src/animation/types";
import type { SceneContext } from "../../../../packages/babylon-lite/src/scene/scene-core";

describe("Babylon.js serializer behavior", () => {
    it("writes one binary geometry document with UTF-8 names, aligned JSON/BIN chunks and no external buffer", async () => {
        const mesh = createMesh("sphere \u{1f600}");
        mesh.rotationQuaternion.set(0.5, 0.5, 0.5, 0.5);
        const { bytes, json } = await exportAndParse(createScene({ meshes: [mesh] }));
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        expect([view.getUint32(0, true), view.getUint32(4, true), view.getUint32(8, true)]).toEqual([0x46546c67, 2, bytes.length]);
        const jsonLength = view.getUint32(12, true);
        const binHeader = 20 + jsonLength;
        const binLength = view.getUint32(binHeader, true);
        expect([view.getUint32(16, true), view.getUint32(binHeader + 4, true)]).toEqual([0x4e4f534a, 0x004e4942]);
        expect([jsonLength % 4, binLength % 4, binHeader + 8 + binLength]).toEqual([0, 0, bytes.length]);
        expect(Object.keys(json).sort()).toEqual(["accessors", "asset", "bufferViews", "buffers", "meshes", "nodes", "scene", "scenes"]);
        expect(json.accessors).toHaveLength(4);
        expect(json.bufferViews).toHaveLength(4);
        expect(json.buffers).toEqual([{ byteLength: expect.any(Number) }]);
        expect(json.buffers[0].byteLength).toBeLessThanOrEqual(binLength);
        expect(json.nodes[0]).toMatchObject({ name: mesh.name, mesh: 0 });
        expect(json.nodes[0].children).toBeUndefined();
        expect(json.meshes[0].primitives[0].material).toBeUndefined();
        expect([mesh.rotationQuaternion.x, mesh.rotationQuaternion.y, mesh.rotationQuaternion.z, mesh.rotationQuaternion.w]).toEqual([0.5, 0.5, 0.5, 0.5]);
    });

    it("omits removed nodes and materials used only by removed or geometry-less meshes", async () => {
        const kept = createMesh("kept", { material: createPbrMaterial({ name: "used" }) });
        const removed = createMesh("removed", { material: createPbrMaterial({ name: "excluded" }) });
        const empty = createMesh("empty", { positions: new Float32Array(), material: createPbrMaterial({ name: "unused" }) });
        const scene = createScene({ meshes: [kept, removed, empty] });
        // Lite filters by scene membership, not shouldExportNode.
        scene.meshes.splice(1, 1);
        const { json } = await exportAndParse(scene);
        expect(json.nodes.map((node: { name: string }) => node.name)).toEqual(["kept", "empty"]);
        expect(json.materials.map((material: { name: string }) => material.name)).toEqual(["used"]);
        expect(json.nodes[1].mesh).toBeUndefined();
    });

    it.each([false, true])("preserves submesh offset ranges, materials and per-primitive morph targets (morph: %s)", async (morph) => {
        const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 2, 1, 0]);
        const indices = new Uint32Array([99, 0, 1, 2, 3, 4, 5, 99]);
        const deltas = [0.5, 0.25].map((base) => Float32Array.from({ length: 18 }, (_, i) => (i % 3 === 1 ? Math.floor(i / 3) * 0.25 + base : 0)));
        const holder = createTransformNode("submeshes");
        const meshes = ["first", "second"].map((name, i) =>
            attach(
                createMesh(name, {
                    positions,
                    normals: null,
                    uvs: null,
                    indices: indices.subarray(1 + i * 3, 4 + i * 3),
                    material: createPbrMaterial({ name }),
                    extra: morph ? { morphTargets: { targets: deltas.map((p) => ({ positions: p, normals: null })), weights: new Float32Array([0.25, 0.75]), count: 2 } } : {},
                }),
                holder
            )
        );
        const glb = await exportAndParse(createScene({ meshes }));
        expect(glb.json.meshes).toHaveLength(1);
        const primitives = glb.json.meshes[0].primitives;
        expect(primitives).toHaveLength(2);
        for (const [i, name] of ["first", "second"].entries()) {
            const primitive = primitives[i];
            expect(glb.json.materials[primitive.material].name).toBe(name);
            expect(readAccessor(glb, primitive.indices)).toEqual(i === 0 ? [0, 1, 2] : [3, 4, 5]);
            expectClose(
                readAccessor(glb, primitive.attributes.POSITION),
                Array.from(positions, (v, j) => (j % 3 === 0 ? -v : v))
            );
            if (morph) {
                expect(glb.json.meshes[0].weights).toEqual([0.25, 0.75]);
                expect(primitive.targets).toHaveLength(2);
                for (let t = 0; t < deltas.length; t++) {
                    expectClose(readAccessor(glb, primitive.targets[t].POSITION), Array.from(deltas[t]!));
                }
            }
        }
    });

    it("serializes translation, scale and quaternion clips together, and excludes removed groups", async () => {
        const target = createMesh("box");
        const input = new Float32Array([0, 20 / 30, 40 / 30]);
        const keys = [0.1, 0.1, 0.1, 1, 1, 1, 0.1, 0.1, 0.1];
        const cases = [
            { path: PATH_TRANSLATION, name: "translation", type: "VEC3", keys, expected: keys.map((v, i) => (i % 3 === 0 ? -v : v)) },
            { path: PATH_SCALE, name: "scale", type: "VEC3", keys, expected: keys },
            { path: PATH_ROTATION, name: "rotation", type: "VEC4", keys: [0.707, 0, 0, 0.707, 0, 0, 0, 1, 0.707, 0, 0, 0.707] },
        ];
        const groups = cases.map(({ path, name, keys }) => ({
            name,
            targetedAnimations: [{ target, path: "position" }],
            _gltfMixer: [{ name, channels: [{ samplerIdx: 0, nodeIdx: 0, path }], samplers: [{ input, output: new Float32Array(keys), interpolation: INTERP_LINEAR }] }, [], []],
        })) as unknown as SceneContext["animationGroups"];
        const scene = createScene({ meshes: [target], animationGroups: groups });
        const glb = await exportAndParse(scene);
        expect(glb.json.animations).toHaveLength(3);
        for (const [i, data] of cases.entries()) {
            const animation = glb.json.animations[i];
            expect(animation.channels).toEqual([{ sampler: 0, target: { node: 0, path: data.name } }]);
            expect(animation.samplers).toHaveLength(1);
            const sampler = animation.samplers[0];
            expect(sampler.interpolation).toBeUndefined();
            expect(glb.json.accessors[sampler.input]).toMatchObject({ componentType: 5126, count: 3, type: "SCALAR", min: [0] });
            expect(glb.json.accessors[sampler.input].max[0]).toBeCloseTo(input[2]!, 6);
            expect(glb.json.accessors[sampler.output]).toMatchObject({ componentType: 5126, count: 3, type: data.type });
            expectClose(readAccessor(glb, sampler.input), Array.from(input));
            expectClose(readAccessor(glb, sampler.output), data.expected ?? data.keys);
        }
        scene.animationGroups.length = 0;
        expect((await exportAndParse(scene)).json.animations).toBeUndefined();
    });

    it("serializes point, spot and directional lights with stable node references", async () => {
        const spot = createSpotLight([-4, 4, 0], [0, Math.PI / 4, 0], Math.PI / 4, 2, 0.2);
        spot.diffuse = [1, 0, 0];
        const { json } = await exportAndParse(createScene({ lights: [createPointLight([4, 4, 0]), spot, createDirectionalLight([0, 0, 1])] }));
        const lights = json.extensions.KHR_lights_punctual.lights;
        expect(lights.map((light: { type: string }) => light.type)).toEqual(["point", "spot", "directional"]);
        expect(lights[1]).toEqual({ type: "spot", intensity: 0.2, color: [1, 0, 0], spot: { outerConeAngle: Math.PI / 8 } });
        expect(json.nodes.map((node: { extensions: { KHR_lights_punctual: { light: number } } }) => node.extensions.KHR_lights_punctual.light)).toEqual([0, 1, 2]);
    });

    it("exports only metadata.gltf.extras", async () => {
        const meshes = [createMesh("plain"), createMesh("extras")];
        meshes[0]!.metadata = { test: "test" };
        meshes[1]!.metadata = { gltf: { extras: { foo: 2, bar: "baz" } } };
        const { json } = await exportAndParse(createScene({ meshes }));
        expect(json.nodes.map((node: { extras?: unknown }) => node.extras)).toEqual([undefined, { foo: 2, bar: "baz" }]);
    });

    it("shares geometry across instances after their source mesh is removed", async () => {
        const source = createMesh("box", { material: createPbrMaterial() });
        const meshes = [1, 2, 3].map((x) => {
            const mesh = createMesh("box", {
                positions: source._cpuPositions,
                normals: source._cpuNormals,
                uvs: source._cpuUvs,
                indices: source._cpuIndices,
                material: source.material,
            });
            mesh.position.x = x;
            return mesh;
        });
        const { json } = await exportAndParse(createScene({ meshes }));
        expect(json.nodes).toHaveLength(3);
        expect(json.meshes).toHaveLength(1);
        expect(json.nodes.map((node: { mesh: number }) => node.mesh)).toEqual([0, 0, 0]);
    });

    it("keeps right-handed parent/child TRS under a stripped loader root", async () => {
        const parent = attach(createMesh("parent"), loaderRoot());
        const child = attach(createMesh("child"), parent);
        for (const mesh of [parent, child]) {
            mesh.position.set(0.2, 0.3, 0.4);
            mesh.scaling.set(0.5, 0.6, 0.7);
            mesh.rotationQuaternion.set(0.5, 0.5, 0.5, 0.5);
        }
        const { json } = await exportAndParse(createScene({ meshes: [parent, child] }));
        expect(json.nodes).toHaveLength(2);
        expect(json.scenes[0].nodes).toEqual([0]);
        expect(json.nodes[0].children).toEqual([1]);
        for (const node of json.nodes) {
            expect(node).toMatchObject({ translation: [0.2, 0.3, 0.4], scale: [0.5, 0.6, 0.7], rotation: [0.5, 0.5, 0.5, 0.5] });
        }
    });

    it.each([false, true])("preserves world placement when removing an intermediate node (kept ancestor: %s)", async (keepParent) => {
        const parent = createMesh("parent");
        parent.position.set(1, 0, 0);
        const middle = attach(createMesh("middle"), parent);
        middle.position.set(0, 2, 0);
        const leaf = attach(createMesh("leaf"), middle);
        leaf.position.set(0, 0, 3);
        setParent(leaf, keepParent ? parent : null);
        middle.parent = null;
        const { json } = await exportAndParse(createScene({ meshes: keepParent ? [parent, leaf] : [leaf] }));
        expect(json.nodes.map((node: { name: string }) => node.name)).toEqual(keepParent ? ["parent", "leaf"] : ["leaf"]);
        expect(json.scenes[0].nodes).toEqual([0]);
        expect(json.nodes.at(-1).matrix.slice(12, 15)).toEqual(keepParent ? [0, 2, 3] : [-1, 2, 3]);
        if (keepParent) {
            expect(json.nodes[0].children).toEqual([1]);
        }
    });
});
