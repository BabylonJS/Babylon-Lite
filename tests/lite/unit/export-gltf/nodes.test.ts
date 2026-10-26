import { describe, expect, it } from "vitest";
import { attach, createMesh, createScene, expectClose, exportAndParse, loaderRoot, readAccessor, setParent } from "./export-test-utils";
import { createTransformNode } from "../../../../packages/babylon-lite/src/scene/transform-node";
import { createSceneNodeFromMatrix } from "../../../../packages/babylon-lite/src/scene/scene-node";
import type { Mat4, Mat4Storage } from "../../../../packages/babylon-lite/src/math/types";
import { createFreeCamera } from "../../../../packages/babylon-lite/src/camera/free-camera";
import { createPbrMaterial } from "../../../../packages/babylon-lite/src/material/pbr/pbr-material";
import { INTERP_LINEAR, PATH_TRANSLATION } from "../../../../packages/babylon-lite/src/animation/types";
import type { SceneContext } from "../../../../packages/babylon-lite/src/scene/scene-core";
import { composeMat4 } from "../../../../packages/babylon-lite/src/math/compose-mat4";
import { multiplyMat4 } from "../../../../packages/babylon-lite/src/math/multiply-mat4";
import { convertMatrix } from "../../../../packages/babylon-lite/src/export-gltf/export-handedness";

function translationGroup(target: object): SceneContext["animationGroups"][number] {
    const clip = {
        name: "move",
        channels: [{ samplerIdx: 0, nodeIdx: 0, path: PATH_TRANSLATION }],
        samplers: [{ input: new Float32Array([0, 1]), output: new Float32Array([0, 0, 0, 1, 2, 3]), interpolation: INTERP_LINEAR }],
        duration: 1,
    };
    return { name: "move", targetedAnimations: [{ target, path: "translation" }], _gltfMixer: [clip, [], []] } as unknown as SceneContext["animationGroups"][number];
}

function gltfLocalMatrix(node: { translation?: number[]; rotation?: number[]; scale?: number[] }): Mat4 {
    const [tx, ty, tz] = node.translation ?? [0, 0, 0];
    const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
    const [sx, sy, sz] = node.scale ?? [1, 1, 1];
    return composeMat4(tx!, ty!, tz!, qx!, qy!, qz!, qw!, sx!, sy!, sz!);
}

describe("root collection", () => {
    it("strips a renamed loader root, preserving asset extras and right-handed geometry", async () => {
        const root = loaderRoot();
        root.name = "renamed";
        root.metadata = { gltf: { extras: { source: "test" } } };
        const mesh = attach(createMesh("m", { authoredSign: -1 }), root);
        mesh.position.set(3, 0, 0);
        const glb = await exportAndParse(createScene({ meshes: [mesh] }));
        expect(glb.json.nodes).toEqual([{ name: "m", translation: [3, 0, 0], mesh: 0 }]);
        const primitive = glb.json.meshes[0].primitives[0];
        expect(readAccessor(glb, primitive.attributes.POSITION)).toEqual(Array.from(mesh._cpuPositions!));
        expect(readAccessor(glb, primitive.indices)).toEqual(Array.from(mesh._cpuIndices!));
        expect(glb.json.asset.extras).toEqual({ source: "test" });
    });

    it.each(["animated", "parented"])("keeps an %s loader root in the converting pass", async (kind) => {
        const root = loaderRoot();
        if (kind === "parented") {
            attach(root, createTransformNode("app", 0, 4, 0));
        }
        const mesh = attach(createMesh("m", { authoredSign: -1 }), root);
        const glb = await exportAndParse(createScene({ meshes: [mesh], animationGroups: kind === "animated" ? [translationGroup(root)] : [] }));
        const index = glb.json.nodes.findIndex((node: { name: string }) => node.name === "__root__");
        expect(glb.json.nodes[index]).toMatchObject({ scale: [-1, 1, 1], mesh: 0 });
        expect(readAccessor(glb, glb.json.meshes[0].primitives[0].indices)).toEqual([0, 2, 1, 0, 3, 2]);
        if (kind === "animated") {
            expect(glb.json.animations[0].channels[0].target.node).toBe(index);
        }
    });

    it("exports a meshless animated root reachable only through a clip", async () => {
        const target = attach(createTransformNode("pivot", 1, 2, 3), loaderRoot());
        const glb = await exportAndParse(createScene({ animationGroups: [translationGroup(target)] }));
        expect(glb.json.nodes).toEqual([{ name: "pivot", translation: [1, 2, 3] }]);
        expect(glb.json.scenes[0].nodes).toEqual([0]);
        expect(glb.json.animations[0].channels[0].target).toEqual({ node: 0, path: "translation" });
    });

    it("honors parent-only links, skips removed children, and keeps GPU-only streams as plain nodes", async () => {
        const parent = createTransformNode("parent");
        const kept = createMesh("kept");
        kept.position.y = 2;
        kept.parent = parent;
        const removed = attach(createMesh("removed"), parent);
        removed.parent = null;
        const stream = attach(createTransformNode("splats", 0, 1, 0), parent);
        Object.assign(stream, { _gpu: {} });
        const glb = await exportAndParse(createScene({ meshes: [kept] }));
        expect(glb.json.nodes.map((node: { name: string }) => node.name)).toEqual(["parent", "splats", "kept"]);
        expect(glb.json.nodes[0].children).toEqual([1, 2]);
        expect(glb.json.nodes[1]).toEqual({ name: "splats", translation: [0, 1, 0] });
        expect(glb.json.nodes[2].children).toBeUndefined();
        expect(glb.warnings).toEqual([]);
    });

    it("exports a non-animated camera child as a world-placed scene root", async () => {
        const camera = createFreeCamera({ x: 1, y: 2, z: 3 }, { x: 1, y: 2, z: 4 });
        const mesh = createMesh("hud");
        setParent(mesh, camera);
        const glb = await exportAndParse(createScene({ meshes: [mesh] }));
        expectClose(glb.json.nodes[0].matrix, convertMatrix(mesh.worldMatrix));
        expect(glb.json.scenes[0].nodes).toEqual([0]);
        expect(glb.warnings).toContain('Node "hud" is parented to a camera, light or other non-node object; exporting it as a scene root at its current world transform.');
    });

    it.each(["camera", "scaled foreign node"])("anchors animated local TRS and descendants under a %s", async (kind) => {
        const parent =
            kind === "camera"
                ? createFreeCamera({ x: 1, y: 2, z: 3 }, { x: 2, y: 2, z: 3 })
                : { worldMatrix: composeMat4(2, -1, 4, 0.5, 0.5, 0.5, 0.5, 2, 0.5, 1.5), worldMatrixVersion: 1 };
        const target = createTransformNode("arm", 0.3, 1, -2, 0, Math.SQRT1_2, 0, Math.SQRT1_2, 1, 2, 1);
        setParent(target, parent);
        const child = attach(createMesh("blade"), target);
        child.position.z = 2;
        const glb = await exportAndParse(createScene({ meshes: [child], animationGroups: [translationGroup(target)] }));
        expect(glb.json.scenes[0].nodes).toEqual([0]);
        expect(glb.json.nodes[0].children).toEqual([1]);
        expect(glb.json.nodes[1]).toMatchObject({ name: "arm", children: [2] });
        expect(glb.json.nodes[2].translation).toEqual([0, 0, 2]);
        expect(glb.json.animations[0].channels[0].target).toEqual({ node: 1, path: "translation" });
        expectClose(glb.json.nodes[0].matrix, convertMatrix(parent.worldMatrix));
        expectClose(multiplyMat4(new Float32Array(glb.json.nodes[0].matrix) as unknown as Mat4, gltfLocalMatrix(glb.json.nodes[1])), convertMatrix(target.worldMatrix));
        expect(glb.warnings.some((warning) => warning.includes("animation target parented to a camera"))).toBe(true);
    });

    it("warns and exports a parent cycle instead of hanging", async () => {
        const a = createTransformNode("a");
        const b = createTransformNode("b");
        // The engine setter itself recurses on cycles; model the corrupted graph directly.
        Object.defineProperty(a, "parent", { value: b });
        Object.defineProperty(b, "parent", { value: a });
        a.children.push(b);
        b.children.push(a);
        const glb = await exportAndParse(createScene({ meshes: [attach(createMesh("m"), a)] }));
        expect(glb.warnings.filter((warning) => warning.includes("parent cycle"))).toHaveLength(1);
        expect(glb.json.meshes).toHaveLength(1);
        expect(glb.json.scenes[0].nodes).toHaveLength(1);
    });
});

describe("node transforms", () => {
    it.each([
        ["float noise", 1e-12, false],
        ["small converting TRS", 0.0005, false],
        ["small pass-through TRS", 0.0005, true],
        ["ordinary converting TRS", 0.5, false],
    ] as const)("preserves %s without mutating source data or folding real transforms", async (_name, value, passThrough) => {
        const node = createTransformNode("n", value, 2 * value, 3 * value, 0, value, 0, Math.sqrt(1 - value * value), 1 + value, 1, 1);
        if (passThrough) {
            attach(node, loaderRoot());
        }
        const a = attach(createMesh("a"), node);
        const b = attach(createMesh("b"), node);
        b.position.x = value;
        const before = JSON.stringify([node.rotationQuaternion, a._cpuPositions, a._cpuIndices]);
        const glb = await exportAndParse(createScene({ meshes: [a, b] }));
        expect(JSON.stringify([node.rotationQuaternion, a._cpuPositions, a._cpuIndices])).toBe(before);
        if (value < 1e-9) {
            expect(glb.json.nodes).toEqual([{ name: "n", mesh: 0 }]);
            expect(glb.json.meshes[0].primitives).toHaveLength(2);
        } else {
            const sign = passThrough ? 1 : -1;
            expectClose(glb.json.nodes[0].translation, [sign * value, 2 * value, 3 * value]);
            expectClose(glb.json.nodes[0].rotation, [0, sign * value, 0, Math.sqrt(1 - value * value)]);
            expectClose(glb.json.nodes[0].scale, [1 + value, 1, 1]);
            expectClose(glb.json.nodes[1].translation, [sign * value, 0, 0]);
        }
    });

    it.each(["noise", "small", "pass-through", "animated", "sheared"])("exports a %s local matrix as valid glTF", async (kind) => {
        const matrix = composeMat4(kind === "noise" ? 1e-12 : 0.0005, 0, 0, 0, 0, 0, 1, 1, 1, 1);
        if (kind === "sheared") {
            (matrix as unknown as Mat4Storage)[4] = 0.5;
        }
        const node = createSceneNodeFromMatrix("n", matrix);
        if (kind === "pass-through") {
            attach(node, loaderRoot());
        }
        const glb = await exportAndParse(createScene({ meshes: [attach(createMesh("m"), node)], animationGroups: kind === "animated" ? [translationGroup(node)] : [] }));
        if (kind === "small" || kind === "pass-through") {
            expectClose(glb.json.nodes[0].matrix, kind === "small" ? convertMatrix(matrix) : Array.from(matrix));
        } else {
            expect(glb.json.nodes[0].matrix).toBeUndefined();
            expect(glb.json.nodes[0].translation).toEqual(kind === "noise" ? undefined : [-matrix[12]!, 0, 0]);
        }
        expect(glb.warnings).toEqual(kind === "sheared" ? ['Node "n" has a sheared local transform, which glTF cannot represent; exporting the nearest TRS.'] : []);
    });

    it("names the foreign parent, not the animated child, in a sheared-anchor warning", async () => {
        const matrix = composeMat4(0, 0, 0, 0, 0, 0, 1, 1, 1, 1);
        (matrix as unknown as Mat4Storage)[4] = 0.5;
        const target = createTransformNode("arm");
        setParent(target, { name: "rig", worldMatrix: matrix, worldMatrixVersion: 1 });
        const glb = await exportAndParse(createScene({ animationGroups: [translationGroup(target)] }));
        expect(glb.warnings).toContain('Node "rig" has a sheared local transform, which glTF cannot represent; exporting the nearest TRS.');
        expect(glb.warnings.join("\n")).not.toContain('Node "arm" has a sheared');
    });
});

describe("mesh folding and sharing", () => {
    it("does not fold children that share instance matrices but not colors", async () => {
        const holder = createTransformNode("holder");
        const matrices = new Float32Array(composeMat4(0, 0, 0, 0, 0, 0, 1, 1, 1, 1));
        const red = new Float32Array([1, 0, 0, 1]);
        const meshes = [red, red, new Float32Array([0, 0, 1, 1]), undefined].map((colors, index) =>
            attach(createMesh(`m${index}`, { extra: { thinInstances: { matrices, count: 1, colors } } }), holder)
        );
        const glb = await exportAndParse(createScene({ meshes }));
        expect(glb.json.nodes).toHaveLength(3);
        expect(glb.json.meshes[0].primitives).toHaveLength(2);
        expect(
            glb.json.nodes.map((node: { extensions: { EXT_mesh_gpu_instancing: { attributes: { _COLOR_0?: number } } } }) => {
                const accessor = node.extensions.EXT_mesh_gpu_instancing.attributes._COLOR_0;
                return accessor === undefined ? undefined : readAccessor(glb, accessor);
            })
        ).toEqual([[1, 0, 0], [0, 0, 1], undefined]);
    });

    it("folds only equal morph counts and weights, separating dropped malformed targets", async () => {
        const holder = createTransformNode("holder");
        const meshes = [
            [0.5, 1, 12],
            [0.5, 1, 12],
            [0.25, 1, 12],
            [0.5, 2, 12],
            [0.5, 1, 9],
        ].map(([weight, count, length], index) =>
            attach(
                createMesh(`m${index}`, {
                    extra: {
                        morphTargets: {
                            targets: Array.from({ length: count! }, () => ({ positions: new Float32Array(length!).fill(0.5), normals: null })),
                            weights: new Float32Array(count!).fill(weight!),
                            count,
                        },
                    },
                }),
                holder
            )
        );
        const glb = await exportAndParse(createScene({ meshes }));
        expect(glb.json.meshes.map((mesh: { primitives: unknown[] }) => mesh.primitives.length)).toEqual([2, 1, 1, 1]);
        expect(glb.json.meshes.map((mesh: { weights?: number[] }) => mesh.weights)).toEqual([[0.5], [0.25], [0.5, 0.5], undefined]);
        for (const mesh of glb.json.meshes) {
            expect(new Set(mesh.primitives.map((primitive: { targets?: unknown[] }) => primitive.targets?.length ?? 0)).size).toBe(1);
        }
    });

    it("keeps a mesh parent's mesh children and their descendants", async () => {
        const parent = createMesh("parent");
        const child = attach(createMesh("child"), parent);
        attach(createTransformNode("marker"), child);
        const glb = await exportAndParse(createScene({ meshes: [parent, child] }));
        expect(glb.json.nodes.map((node: { name: string }) => node.name)).toEqual(["parent", "child", "marker"]);
        expect(glb.json.nodes[0].children).toEqual([1]);
        expect(glb.json.nodes[1].children).toEqual([2]);
        expect(glb.json.meshes.map((mesh: { primitives: unknown[] }) => mesh.primitives.length)).toEqual([1, 1]);
    });

    it("shares geometry while keeping mesh names, materials and extras distinct", async () => {
        const material = createPbrMaterial({});
        const source = createMesh("tile", { material });
        const geometry = { positions: source._cpuPositions!, normals: source._cpuNormals!, uvs: source._cpuUvs!, indices: source._cpuIndices! };
        const meshes = [
            { name: "tile", material, tag: "x" },
            { name: "tile", material, tag: "x" },
            { name: "other", material, tag: "x" },
            { name: "tile", material: createPbrMaterial({ metallicFactor: 0 }), tag: "x" },
            { name: "tile", material, tag: "y" },
        ].map(({ name, material, tag }, index) => {
            const mesh = attach(createMesh(name, { ...geometry, material }), createTransformNode(`holder${index}`));
            mesh.metadata = { gltf: { extras: { tag } } };
            return mesh;
        });
        const glb = await exportAndParse(createScene({ meshes }));
        expect(glb.json.nodes.map((node: { mesh: number }) => node.mesh)).toEqual([0, 0, 1, 2, 3]);
        expect(glb.json.meshes.map((mesh: { name: string; extras: unknown }) => [mesh.name, mesh.extras])).toEqual([
            ["tile", { tag: "x" }],
            ["other", { tag: "x" }],
            ["tile", { tag: "x" }],
            ["tile", { tag: "y" }],
        ]);
        expect(glb.json.meshes[1].primitives).toEqual(glb.json.meshes[0].primitives);
        expect(glb.json.meshes[2].primitives[0].material).not.toBe(glb.json.meshes[0].primitives[0].material);
    });

    it.each(["shared", "distinct", "invalid"])("exports the first independent mesh extras (%s)", async (kind) => {
        const extras = { from: "node" };
        const holder = createTransformNode("holder");
        holder.metadata = { gltf: { extras } };
        const a = attach(createMesh("a"), holder);
        const b = attach(createMesh("b"), holder);
        a.metadata = { gltf: { extras } };
        b.metadata = { gltf: { extras: kind === "shared" ? extras : kind === "distinct" ? { from: "mesh" } : { invalid: BigInt(1) } } };
        const glb = await exportAndParse(createScene({ meshes: [a, b] }));
        expect(glb.json.nodes[0].extras).toEqual(extras);
        expect(glb.json.meshes[0].extras).toEqual(kind === "distinct" ? { from: "mesh" } : undefined);
        expect(glb.warnings).toEqual(kind === "invalid" ? ['Extras of "b" are not JSON-serializable; exporting without them.'] : []);
    });
});
