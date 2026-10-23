import { describe, expect, it } from "vitest";
import { attach, createMesh, createScene, exportAndParse, readAccessor } from "./export-test-utils";
import { createTransformNode } from "../../../../packages/babylon-lite/src/scene/transform-node";
import { createSceneNodeFromMatrix } from "../../../../packages/babylon-lite/src/scene/scene-node";
import type { SceneNode } from "../../../../packages/babylon-lite/src/scene/scene-node";
import type { Mat4 } from "../../../../packages/babylon-lite/src/math/types";
import { createPointLight } from "../../../../packages/babylon-lite/src/light/point-light";
import { createFreeCamera } from "../../../../packages/babylon-lite/src/camera/free-camera";
import { createPbrMaterial } from "../../../../packages/babylon-lite/src/material/pbr/pbr-material";
import { INTERP_LINEAR, PATH_TRANSLATION } from "../../../../packages/babylon-lite/src/animation/types";
import type { SceneContext } from "../../../../packages/babylon-lite/src/scene/scene-core";
import { composeMat4 } from "../../../../packages/babylon-lite/src/math/compose-mat4";
import { multiplyMat4 } from "../../../../packages/babylon-lite/src/math/multiply-mat4";
import { convertMatrix } from "../../../../packages/babylon-lite/src/export-gltf/export-handedness";

type AnimationGroups = SceneContext["animationGroups"];

const SQRT1_2 = Math.SQRT1_2;

function expectClose(actual: ArrayLike<number> | undefined, expected: number[]): void {
    expect(actual).toBeDefined();
    expect(actual!.length).toBe(expected.length);
    for (let i = 0; i < expected.length; i++) {
        expect(actual![i]).toBeCloseTo(expected[i]!, 5);
    }
}

/** An exported node's local TRS as a matrix (glTF defaults for absent members). */
function gltfLocalMatrix(node: { translation?: number[]; rotation?: number[]; scale?: number[] }): Mat4 {
    const [tx, ty, tz] = node.translation ?? [0, 0, 0];
    const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
    const [sx, sy, sz] = node.scale ?? [1, 1, 1];
    return composeMat4(tx!, ty!, tz!, qx!, qy!, qz!, qw!, sx!, sy!, sz!);
}

/** The loader's conversion root. */
function loaderRoot(): SceneNode {
    return createTransformNode("__root__", 0, 0, 0, 0, 0, 0, 1, -1, 1, 1);
}

function matrixNode(name: string, matrix: number[]): SceneNode {
    return createSceneNodeFromMatrix(name, new Float32Array(matrix) as unknown as Mat4);
}

const TRANSLATE_5X = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1];
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** A one-channel translation animation group targeting `target`. */
function translationGroup(name: string, target: object, targetPath = "translation"): AnimationGroups[number] {
    const clip = {
        name,
        channels: [{ samplerIdx: 0, nodeIdx: 0, path: PATH_TRANSLATION }],
        samplers: [{ input: new Float32Array([0, 1]), output: new Float32Array([0, 0, 0, 1, 2, 3]), interpolation: INTERP_LINEAR }],
        duration: 1,
    };
    return { name, targetedAnimations: [{ target, path: targetPath }], _gltfMixer: [clip, [], []] } as unknown as AnimationGroups[number];
}

function names(json: { nodes?: { name?: string }[] }, indices: number[]): (string | undefined)[] {
    return indices.map((i) => json.nodes![i]!.name);
}

describe("root collection", () => {
    it("orders roots meshes, then lights, then camera, then animation targets", async () => {
        const mesh = createMesh("m");
        const lightParent = createTransformNode("lightParent");
        const light = createPointLight([0, 0, 0]);
        light.parent = lightParent;
        const camParent = createTransformNode("camParent");
        const camera = createFreeCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
        (camera as { parent: unknown }).parent = camParent;
        const animNode = createTransformNode("animNode");
        const scene = createScene({ meshes: [mesh], lights: [light], camera, animationGroups: [translationGroup("g", animNode)] });
        const glb = await exportAndParse(scene);
        expect(names(glb.json, glb.json.scenes[0].nodes)).toEqual(["m", "lightParent", "camParent", "animNode"]);
        // The camera attaches under its (non-fixup) parent; the light collapses onto its parent.
        expect(glb.json.nodes[1].extensions.KHR_lights_punctual.light).toBe(0);
        expect(glb.json.nodes[2].children.map((i: number) => glb.json.nodes[i].camera)).toEqual([0]);
    });

    it("exports an animated meshless TransformNode root reachable only through an animation target", async () => {
        const target = createTransformNode("pivot", 1, 2, 3);
        const glb = await exportAndParse(createScene({ animationGroups: [translationGroup("spin", target)] }));
        expect(glb.json.nodes).toHaveLength(1);
        expect(glb.json.nodes[0].name).toBe("pivot");
        expect(glb.json.nodes[0].translation).toEqual([-1, 2, 3]);
        expect(glb.json.scenes[0].nodes).toEqual([0]);
        expect(glb.json.animations).toHaveLength(1);
        expect(glb.json.animations[0].channels[0].target.node).toBe(0);
    });

    it("strips the loader root: children become scene roots in pass-through, with asset extras", async () => {
        const root = loaderRoot();
        root.metadata = { gltf: { extras: { source: "unit-test", n: 2 } } };
        const mesh = createMesh("m", { authoredSign: -1, positions: new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]) });
        mesh.position.set(3, 0, 0);
        attach(mesh, root);
        const glb = await exportAndParse(createScene({ meshes: [mesh] }));
        expect(glb.json.nodes).toHaveLength(1);
        expect(glb.json.scenes[0].nodes).toEqual([0]);
        // Pass-through: translation and positions verbatim, indices not reversed for authoredSign -1.
        expect(glb.json.nodes[0].translation).toEqual([3, 0, 0]);
        expect(glb.json.nodes[0].scale).toBeUndefined();
        const primitive = glb.json.meshes[0].primitives[0];
        expect(readAccessor(glb, primitive.attributes.POSITION)).toEqual([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
        expect(readAccessor(glb, primitive.indices)).toEqual([0, 1, 2, 0, 2, 3]);
        expect(glb.json.asset.extras).toEqual({ source: "unit-test", n: 2 });
        expect(glb.warnings).toEqual([]);
    });

    it("does not strip a (-1,1,1) root that is an animation target", async () => {
        const root = loaderRoot();
        const mesh = createMesh("m", { authoredSign: -1 });
        attach(mesh, root);
        const glb = await exportAndParse(createScene({ meshes: [mesh], animationGroups: [translationGroup("g", root)] }));
        expect(glb.json.scenes[0].nodes).toEqual([0]);
        // The mesh child has identity TRS, so it folds into the root node.
        expect(glb.json.nodes).toHaveLength(1);
        expect(glb.json.nodes[0].name).toBe("__root__");
        expect(glb.json.nodes[0].scale).toEqual([-1, 1, 1]);
        expect(glb.json.nodes[0].mesh).toBe(0);
        // The root is a converting root, so its child converts: positions mirror and authoredSign -1 reverses winding.
        const primitive = glb.json.meshes[0].primitives[0];
        expect(readAccessor(glb, primitive.attributes.POSITION).slice(0, 3)).toEqual([1, -1, 0]);
        expect(readAccessor(glb, primitive.indices)).toEqual([0, 2, 1, 0, 3, 2]);
    });

    it("exports a loader root parented under an application node as a node with scale [-1,1,1] in a converting pass", async () => {
        const app = createTransformNode("app", 0, 4, 0);
        const root = attach(loaderRoot(), app);
        const mesh = attach(createMesh("m", { authoredSign: -1 }), root);
        const glb = await exportAndParse(createScene({ meshes: [mesh] }));
        expect(glb.json.scenes[0].nodes).toEqual([0]);
        // The identity-TRS mesh folds into the root node.
        expect(names(glb.json, [0, 1])).toEqual(["app", "__root__"]);
        expect(glb.json.nodes).toHaveLength(2);
        expect(glb.json.nodes[0].translation).toEqual([0, 4, 0]);
        expect(glb.json.nodes[1].scale).toEqual([-1, 1, 1]);
        expect(glb.json.nodes[0].children).toEqual([1]);
        expect(glb.json.nodes[1].mesh).toBe(0);
        // Converting: the authoredSign -1 mesh reverses its winding.
        expect(readAccessor(glb, glb.json.meshes[0].primitives[0].indices)).toEqual([0, 2, 1, 0, 3, 2]);
    });

    it("still exports a child linked only through child.parent", async () => {
        const parent = createTransformNode("parent", 1, 0, 0);
        const mesh = createMesh("m");
        mesh.position.set(0, 2, 0); // non-identity TRS: the mesh keeps its own node
        mesh.parent = parent;
        expect(parent.children).not.toContain(mesh);
        const glb = await exportAndParse(createScene({ meshes: [mesh] }));
        expect(glb.json.scenes[0].nodes).toEqual([0]);
        expect(names(glb.json, [0, 1])).toEqual(["parent", "m"]);
        expect(glb.json.nodes[0].children).toEqual([1]);
        expect(glb.json.nodes[1].mesh).toBe(0);
    });

    it("skips a node still listed in parent.children whose parent is null", async () => {
        const parent = createTransformNode("parent");
        const kept = attach(createMesh("kept"), parent);
        kept.position.set(0, 2, 0); // non-identity TRS: the mesh keeps its own node
        const removed = attach(createMesh("removed"), parent);
        removed.position.set(0, 3, 0);
        removed.parent = null; // removeFromScene clears the parent link but leaves the children entry
        expect(parent.children).toContain(removed);
        const glb = await exportAndParse(createScene({ meshes: [kept] }));
        expect(glb.json.nodes.map((n: { name: string }) => n.name)).toEqual(["parent", "kept"]);
    });

    it("skips lights and cameras listed in children during the sweep", async () => {
        const parent = createTransformNode("parent");
        const mesh = attach(createMesh("m"), parent);
        const light = attach(createPointLight([0, 0, 0]), parent);
        const camera = createFreeCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
        (camera as { parent: unknown }).parent = parent;
        parent.children.push(camera as unknown as SceneNode);
        const glb = await exportAndParse(createScene({ meshes: [mesh], lights: [light], camera }));
        // parent (holding the folded mesh and collapsed light) plus the camera's own node; no node for the listed light/camera objects.
        expect(glb.json.nodes).toHaveLength(2);
        expect(glb.json.nodes[0].extensions.KHR_lights_punctual.light).toBe(0);
        expect(glb.json.nodes[0].children).toEqual([1]);
        expect(glb.json.nodes[1].camera).toBe(0);
    });

    it("exports a mesh parented to a camera as a world-placed scene root with a warning", async () => {
        const camera = createFreeCamera({ x: 1, y: 2, z: 3 }, { x: 1, y: 2, z: 4 });
        const mesh = createMesh("hud");
        (mesh as { parent: unknown }).parent = camera;
        const glb = await exportAndParse(createScene({ meshes: [mesh] }));
        expect(glb.json.scenes[0].nodes).toEqual([0]);
        expect(glb.warnings).toContain('Node "hud" is parented to a camera, light or other non-node object; exporting it as a scene root at its current world transform.');
        expectClose(glb.json.nodes[0].matrix, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -1, 2, 3, 1]);
    });

    it("anchors an animated node parented to a camera so its local animation keys keep the parent transform", async () => {
        const camera = createFreeCamera({ x: 1, y: 2, z: 3 }, { x: 2, y: 2, z: 3 });
        const target = createTransformNode("spinner", 0, 1, 0.5);
        (target as { parent: unknown }).parent = camera;
        const glb = await exportAndParse(createScene({ animationGroups: [translationGroup("g", target)] }));
        expect(glb.warnings).toContain(
            'Node "spinner" is an animation target parented to a camera, light or other non-node object; exporting it under a scene-root node at the parent\'s current world transform.'
        );
        // The anchor root carries the camera's world transform; the target keeps its local TRS, which the channel replaces.
        expect(glb.json.scenes[0].nodes).toEqual([0]);
        expect(glb.json.nodes[0].children).toEqual([1]);
        expect(glb.json.nodes[1].name).toBe("spinner");
        expectClose(glb.json.nodes[1].translation, [0, 1, 0.5]);
        expect(glb.json.animations[0].channels[0].target).toEqual({ node: 1, path: "translation" });
        const anchor = glb.json.nodes[0].matrix as number[];
        expectClose(anchor, convertMatrix(camera.worldMatrix));
        expectClose(multiplyMat4(new Float32Array(anchor) as unknown as Mat4, gltfLocalMatrix(glb.json.nodes[1])), convertMatrix(target.worldMatrix));
    });

    it("anchors an animated rotated and scaled node under a rotated and scaled foreign parent", async () => {
        const h = Math.sqrt(0.5);
        const parentMatrix = composeMat4(2, -1, 4, 0.5, 0.5, 0.5, 0.5, 2, 0.5, 1.5);
        const parent = { worldMatrix: parentMatrix, worldMatrixVersion: 1 };
        const target = createTransformNode("arm", 0.3, 1, -2, 0, h, 0, h, 1, 2, 1);
        (target as { parent: unknown }).parent = parent;
        const glb = await exportAndParse(createScene({ animationGroups: [translationGroup("g", target)] }));
        expect(glb.json.nodes[0].name).toBeUndefined();
        expect(glb.json.nodes[0].children).toEqual([1]);
        expectClose(glb.json.nodes[0].matrix, convertMatrix(parentMatrix));
        expectClose(multiplyMat4(new Float32Array(glb.json.nodes[0].matrix) as unknown as Mat4, gltfLocalMatrix(glb.json.nodes[1])), convertMatrix(target.worldMatrix));
    });

    it("keeps a non-animated child of an animated foreign-parented node local under the anchored target", async () => {
        const camera = createFreeCamera({ x: 1, y: 2, z: 3 }, { x: 2, y: 2, z: 3 });
        const target = createTransformNode("spinner", 0, 1, 0);
        (target as { parent: unknown }).parent = camera;
        const child = attach(createMesh("blade"), target);
        child.position.set(0, 0, 2);
        const glb = await exportAndParse(createScene({ meshes: [child], animationGroups: [translationGroup("g", target)] }));
        expect(glb.json.scenes[0].nodes).toEqual([0]);
        expect(names(glb.json, [1, 2])).toEqual(["spinner", "blade"]);
        expect(glb.json.nodes[1].children).toEqual([2]);
        expectClose(glb.json.nodes[2].translation, [0, 0, 2]);
    });
});

describe("parent cycles", () => {
    it("warns and exports instead of hanging when the scene graph contains a parent cycle", async () => {
        const a = createTransformNode("a");
        const b = createTransformNode("b");
        // The engine's own parent setter cannot form a cycle (it recurses), so define plain properties.
        Object.defineProperty(a, "parent", { value: b, configurable: true });
        Object.defineProperty(b, "parent", { value: a, configurable: true });
        a.children.push(b);
        b.children.push(a);
        const mesh = attach(createMesh("m"), a);
        const glb = await exportAndParse(createScene({ meshes: [mesh] }));
        expect(glb.warnings.filter((w) => /is part of a parent cycle; exporting the cycle from this node\./.test(w))).toHaveLength(1);
        expect(glb.json.nodes.length).toBeGreaterThanOrEqual(2);
        expect(glb.json.meshes).toHaveLength(1);
        expect(glb.json.scenes[0].nodes).toHaveLength(1);
    });
});

describe("node transforms", () => {
    it("omits TRS components that differ from their defaults only by float noise", async () => {
        const node = createTransformNode("n", 1e-12, -1e-12, 0, 1e-12, 0, 0, 1, 1 + 1e-12, 1 - 1e-12, 1);
        const mesh = attach(createMesh("m"), node);
        const glb = await exportAndParse(createScene({ meshes: [mesh] }));
        expect(glb.json.nodes[0].translation).toBeUndefined();
        expect(glb.json.nodes[0].rotation).toBeUndefined();
        expect(glb.json.nodes[0].scale).toBeUndefined();
        expect(glb.json.nodes[0].matrix).toBeUndefined();
    });

    it("keeps small real TRS values instead of treating them as defaults", async () => {
        const half = 0.0004 / 2;
        const node = createTransformNode("n", 0.0005, -0.0005, 0, half, 0, 0, Math.sqrt(1 - half * half), 1.0005, 0.9995, 1);
        const mesh = attach(createMesh("m"), node);
        const glb = await exportAndParse(createScene({ meshes: [mesh] }));
        expectClose(glb.json.nodes[0].translation, [-0.0005, -0.0005, 0]);
        expect(glb.json.nodes[0].rotation).toBeDefined();
        expect(Math.abs(glb.json.nodes[0].rotation[0])).toBeCloseTo(half, 6);
        expectClose(glb.json.nodes[0].scale, [1.0005, 0.9995, 1]);
    });

    it("keeps a small real translation in a pass-through pass", async () => {
        const root = loaderRoot();
        const node = attach(createTransformNode("n", 0.0005, 0, 0), root);
        const glb = await exportAndParse(createScene({ meshes: [attach(createMesh("m", { authoredSign: -1 }), node)] }));
        expectClose(glb.json.nodes[0].translation, [0.0005, 0, 0]);
    });

    it("keeps a _localMatrix that differs from identity by a small real amount and omits float noise", async () => {
        const nearIdentity = matrixNode("near", [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.0005, 0, 0, 1]);
        const glbNear = await exportAndParse(createScene({ meshes: [attach(createMesh("a"), nearIdentity)] }));
        expectClose(glbNear.json.nodes[0].matrix, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -0.0005, 0, 0, 1]);
        const noise = matrixNode("noise", [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1e-12, 0, 0, 1]);
        const glbNoise = await exportAndParse(createScene({ meshes: [attach(createMesh("b"), noise)] }));
        expect(glbNoise.json.nodes[0].matrix).toBeUndefined();
    });

    it("converts TRS in a converting pass: negates translation X and converts the rotation", async () => {
        // 60 degrees about +Y.
        const node = createTransformNode("n", 1, 2, 3, 0, 0.5, 0, Math.sqrt(3) / 2, 1, 2, 3);
        const glb = await exportAndParse(createScene({ meshes: [attach(createMesh("m"), node)] }));
        expectClose(glb.json.nodes[0].translation, [-1, 2, 3]);
        expectClose(glb.json.nodes[0].rotation, [0, -0.5, 0, Math.sqrt(3) / 2]);
        expect(glb.json.nodes[0].scale).toEqual([1, 2, 3]);
    });

    it("emits TRS verbatim in a pass-through pass", async () => {
        const root = loaderRoot();
        const node = attach(createTransformNode("n", 1, 2, 3, 0, SQRT1_2, 0, SQRT1_2, 1, 2, 3), root);
        const mesh = attach(createMesh("m", { authoredSign: -1 }), node);
        const glb = await exportAndParse(createScene({ meshes: [mesh] }));
        expectClose(glb.json.nodes[0].translation, [1, 2, 3]);
        expectClose(glb.json.nodes[0].rotation, [0, SQRT1_2, 0, SQRT1_2]);
    });

    it("emits _localMatrix as C·M·C when converting, verbatim in pass-through, and omits an identity matrix", async () => {
        const converting = matrixNode("conv", TRANSLATE_5X);
        const convMesh = attach(createMesh("a"), converting);
        const glbConv = await exportAndParse(createScene({ meshes: [convMesh] }));
        expect(glbConv.json.nodes[0].matrix).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -5, 0, 0, 1]);

        const root = loaderRoot();
        const pass = attach(matrixNode("pass", TRANSLATE_5X), root);
        const passMesh = attach(createMesh("b", { authoredSign: -1 }), pass);
        const glbPass = await exportAndParse(createScene({ meshes: [passMesh] }));
        expect(glbPass.json.nodes[0].matrix).toEqual(TRANSLATE_5X);

        const identity = matrixNode("id", IDENTITY);
        const idMesh = attach(createMesh("c"), identity);
        const glbId = await exportAndParse(createScene({ meshes: [idMesh] }));
        expect(glbId.json.nodes[0].matrix).toBeUndefined();
        expect(glbId.json.nodes[0].translation).toBeUndefined();
    });

    it("emits TRS plus a warning for a sheared _localMatrix", async () => {
        const sheared = matrixNode("shear", [1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 2, 0, 0, 1]);
        const mesh = attach(createMesh("m"), sheared);
        const glb = await exportAndParse(createScene({ meshes: [mesh] }));
        expect(glb.json.nodes[0].matrix).toBeUndefined();
        expect(glb.json.nodes[0].translation).toBeDefined();
        expect(glb.warnings).toContain('Node "shear" has a sheared local transform, which glTF cannot represent; exporting the nearest TRS.');
    });

    it("emits TRS for an animated node with a _localMatrix", async () => {
        const node = matrixNode("anim", TRANSLATE_5X);
        const mesh = attach(createMesh("m"), node);
        const glb = await exportAndParse(createScene({ meshes: [mesh], animationGroups: [translationGroup("g", node)] }));
        expect(glb.json.nodes[0].matrix).toBeUndefined();
        expectClose(glb.json.nodes[0].translation, [-5, 0, 0]);
        expect(glb.warnings).toEqual([]);
    });
});

describe("mesh folding", () => {
    function quad(name: string, x: number, options: { extra?: Record<string, unknown> } = {}) {
        return createMesh(name, { positions: new Float32Array([x, 0, 0, x + 1, 0, 0, x + 1, 1, 0, x, 1, 0]), ...options });
    }

    it("folds identity-TRS mesh children into one glTF mesh with primitives in child order", async () => {
        const holder = createTransformNode("holder");
        const a = attach(quad("a", 10), holder);
        const b = attach(quad("b", 20), holder);
        const c = attach(quad("c", 30), holder);
        const glb = await exportAndParse(createScene({ meshes: [a, b, c] }));
        expect(glb.json.nodes).toHaveLength(1);
        expect(glb.json.meshes).toHaveLength(1);
        const primitives = glb.json.meshes[0].primitives;
        expect(primitives).toHaveLength(3);
        // Converting mirrors X, so the first position component is the negated child offset.
        expect(primitives.map((p: { attributes: { POSITION: number } }) => readAccessor(glb, p.attributes.POSITION)[0])).toEqual([-10, -20, -30]);
        expect(glb.json.nodes[0].mesh).toBe(0);
    });

    it("does not fold a mesh with a non-identity transform", async () => {
        const holder = createTransformNode("holder");
        const a = attach(quad("a", 1), holder);
        const b = attach(quad("b", 2), holder);
        b.position.set(0, 5, 0);
        const glb = await exportAndParse(createScene({ meshes: [a, b] }));
        expect(glb.json.nodes).toHaveLength(2);
        expect(glb.json.nodes[0].mesh).toBeDefined();
        expect(glb.json.nodes[1].mesh).toBeDefined();
        expect(glb.json.nodes[0].children).toEqual([1]);
    });

    it("does not fold children whose thin-instance matrices differ", async () => {
        const holder = createTransformNode("holder");
        const m1 = new Float32Array([...IDENTITY]);
        const m2 = new Float32Array([...IDENTITY]);
        const a = attach(quad("a", 1, { extra: { thinInstances: { matrices: m1, count: 1 } } }), holder);
        const sameAsA = attach(quad("a2", 2, { extra: { thinInstances: { matrices: m1, count: 1 } } }), holder);
        const b = attach(quad("b", 3, { extra: { thinInstances: { matrices: m2, count: 1 } } }), holder);
        const glb = await exportAndParse(createScene({ meshes: [a, sameAsA, b] }));
        expect(glb.json.nodes).toHaveLength(2);
        expect(glb.json.meshes).toHaveLength(2);
        expect(glb.json.meshes[0].primitives).toHaveLength(2);
        expect(glb.json.meshes[1].primitives).toHaveLength(1);
        expect(glb.json.nodes[0].children).toEqual([1]);
    });

    it("does not fold children whose morph weights differ", async () => {
        const morph = (weight: number) => ({
            morphTargets: { targets: [{ positions: new Float32Array(12).fill(0.5), normals: null }], weights: new Float32Array([weight]), count: 1 },
        });
        const holder = createTransformNode("holder");
        const a = attach(quad("a", 1, { extra: morph(0.5) }), holder);
        const sameAsA = attach(quad("a2", 2, { extra: morph(0.5) }), holder);
        const b = attach(quad("b", 3, { extra: morph(0.25) }), holder);
        const glb = await exportAndParse(createScene({ meshes: [a, sameAsA, b] }));
        expect(glb.json.nodes).toHaveLength(2);
        expect(glb.json.meshes[0].primitives).toHaveLength(2);
        expect(glb.json.meshes[0].weights).toEqual([0.5]);
        expect(glb.json.meshes[1].weights).toEqual([0.25]);
    });

    it("does not fold children that share thin-instance matrices but not instance colors", async () => {
        const holder = createTransformNode("holder");
        const matrices = new Float32Array([...IDENTITY]);
        const red = new Float32Array([1, 0, 0, 1]);
        const a = attach(quad("a", 1, { extra: { thinInstances: { matrices, count: 1, colors: red } } }), holder);
        const sameAsA = attach(quad("a2", 2, { extra: { thinInstances: { matrices, count: 1, colors: red } } }), holder);
        const blue = attach(quad("b", 3, { extra: { thinInstances: { matrices, count: 1, colors: new Float32Array([0, 0, 1, 1]) } } }), holder);
        const plain = attach(quad("c", 4, { extra: { thinInstances: { matrices, count: 1 } } }), holder);
        const glb = await exportAndParse(createScene({ meshes: [a, sameAsA, blue, plain] }));
        expect(glb.json.nodes).toHaveLength(3);
        expect(glb.json.meshes[0].primitives).toHaveLength(2);
        const colorOf = (node: { extensions?: Record<string, { attributes: { _COLOR_0?: number } }> }) => {
            const accessor = node.extensions?.EXT_mesh_gpu_instancing?.attributes._COLOR_0;
            return accessor === undefined ? undefined : readAccessor(glb, accessor);
        };
        expect(glb.json.nodes.map(colorOf)).toEqual([[1, 0, 0], [0, 0, 1], undefined]);
    });

    it("does not fold a child whose morph targets would be dropped next to one whose targets export", async () => {
        const morph = (positions: number) => ({
            morphTargets: { targets: [{ positions: new Float32Array(positions).fill(0.5), normals: null }], weights: new Float32Array([0.5]), count: 1 },
        });
        const holder = createTransformNode("holder");
        const a = attach(quad("a", 1, { extra: morph(12) }), holder);
        const bad = attach(quad("bad", 2, { extra: morph(9) }), holder);
        const glb = await exportAndParse(createScene({ meshes: [a, bad] }));
        for (const mesh of glb.json.meshes) {
            const counts = mesh.primitives.map((p: { targets?: unknown[] }) => p.targets?.length ?? 0);
            expect(new Set(counts).size).toBe(1);
        }
        expect(glb.json.meshes).toHaveLength(2);
        expect(glb.json.meshes[0].weights).toEqual([0.5]);
        expect(glb.json.meshes[1].weights).toBeUndefined();
    });

    it("does not fold an animated child", async () => {
        const holder = createTransformNode("holder");
        const a = attach(quad("a", 1), holder);
        const b = attach(quad("b", 2), holder);
        const glb = await exportAndParse(createScene({ meshes: [a, b], animationGroups: [translationGroup("g", b)] }));
        expect(glb.json.nodes).toHaveLength(2);
        expect(glb.json.meshes[0].primitives).toHaveLength(1);
        expect(glb.json.nodes[1].name).toBe("b");
        expect(glb.json.animations[0].channels[0].target.node).toBe(1);
    });

    it("does not fold a child that has its own children", async () => {
        const holder = createTransformNode("holder");
        const a = attach(quad("a", 1), holder);
        const b = attach(quad("b", 2), holder);
        attach(createTransformNode("grandchild"), b);
        const glb = await exportAndParse(createScene({ meshes: [a, b] }));
        expect(names(glb.json, [0, 1, 2])).toEqual(["holder", "b", "grandchild"]);
        expect(glb.json.nodes[0].children).toEqual([1]);
        expect(glb.json.nodes[1].children).toEqual([2]);
        expect(glb.json.meshes).toHaveLength(2);
    });

    it("never lets a Mesh absorb its mesh children", async () => {
        const parent = createMesh("parentMesh");
        const child = attach(createMesh("childMesh"), parent);
        const glb = await exportAndParse(createScene({ meshes: [parent, child] }));
        expect(glb.json.nodes).toHaveLength(2);
        expect(glb.json.nodes[0].mesh).toBeDefined();
        expect(glb.json.nodes[1].mesh).toBeDefined();
        for (const mesh of glb.json.meshes) {
            expect(mesh.primitives).toHaveLength(1);
        }
        expect(glb.json.nodes[0].children).toEqual([1]);
    });

    describe("sharing a glTF mesh between nodes", () => {
        const positions = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
        const normals = new Float32Array([0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1]);
        const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
        const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
        const sharedMesh = (name: string, material: ReturnType<typeof createPbrMaterial>) => createMesh(name, { positions, normals, uvs, indices, material });

        it("exports ONE glTF mesh for two same-named nodes sharing geometry arrays and material", async () => {
            const material = createPbrMaterial({});
            const a = sharedMesh("tile", material);
            const b = sharedMesh("tile", material);
            b.position.set(4, 0, 0);
            const glb = await exportAndParse(createScene({ meshes: [a, b] }));
            expect(glb.json.nodes).toHaveLength(2);
            expect(glb.json.meshes).toHaveLength(1);
            expect(glb.json.meshes[0].name).toBe("tile");
            expect(glb.json.nodes.map((n: { mesh: number }) => n.mesh)).toEqual([0, 0]);
            expect(glb.json.materials).toHaveLength(1);
        });

        it("exports separate glTF meshes, sharing the accessors and material, for differently named nodes", async () => {
            const material = createPbrMaterial({});
            const glb = await exportAndParse(createScene({ meshes: [sharedMesh("a", material), sharedMesh("b", material)] }));
            expect(glb.json.nodes).toHaveLength(2);
            expect(glb.json.meshes.map((m: { name: string }) => m.name)).toEqual(["a", "b"]);
            expect(glb.json.nodes.map((n: { mesh: number }) => n.mesh)).toEqual([0, 1]);
            expect(glb.json.meshes[1].primitives).toEqual(glb.json.meshes[0].primitives);
            expect(glb.json.materials).toHaveLength(1);
        });

        it("exports separate glTF meshes for same-named nodes with different materials", async () => {
            const glb = await exportAndParse(createScene({ meshes: [sharedMesh("tile", createPbrMaterial({})), sharedMesh("tile", createPbrMaterial({ metallicFactor: 0 }))] }));
            expect(glb.json.meshes).toHaveLength(2);
        });

        describe("mesh extras", () => {
            const material = createPbrMaterial({});
            const holderWith = (name: string, meshExtras: unknown) => {
                const holder = createTransformNode(name);
                holder.metadata = { gltf: { extras: { owner: name } } };
                const mesh = attach(sharedMesh("tile", material), holder);
                mesh.metadata = { gltf: { extras: meshExtras } };
                return mesh;
            };

            it("shares one glTF mesh when the mesh extras are identical", async () => {
                const glb = await exportAndParse(createScene({ meshes: [holderWith("h1", { kind: "x" }), holderWith("h2", { kind: "x" })] }));
                expect(glb.json.nodes).toHaveLength(2);
                expect(glb.json.meshes).toHaveLength(1);
                expect(glb.json.meshes[0].extras).toEqual({ kind: "x" });
            });

            it("keeps separate glTF meshes when the mesh extras differ", async () => {
                const glb = await exportAndParse(createScene({ meshes: [holderWith("h1", { kind: "x" }), holderWith("h2", { kind: "y" })] }));
                expect(glb.json.nodes).toHaveLength(2);
                expect(glb.json.meshes.map((m: { extras: unknown }) => m.extras)).toEqual([{ kind: "x" }, { kind: "y" }]);
                expect(glb.json.nodes.map((n: { mesh: number }) => n.mesh)).toEqual([0, 1]);
            });
        });
    });

    it("does not fold a mesh child whose translation is a small real value", async () => {
        const holder = createTransformNode("holder");
        const a = attach(quad("a", 1), holder);
        const b = attach(quad("b", 2), holder);
        b.position.set(0.0005, 0, 0);
        const glb = await exportAndParse(createScene({ meshes: [a, b] }));
        expect(glb.json.nodes).toHaveLength(2);
        expectClose(glb.json.nodes[1].translation, [-0.0005, 0, 0]);
    });

    it("still folds a mesh child whose TRS differs from identity only by float noise", async () => {
        const holder = createTransformNode("holder");
        const a = attach(quad("a", 1), holder);
        const b = attach(quad("b", 2), holder);
        b.position.set(1e-12, 0, 0);
        b.scaling.set(1 + 1e-12, 1, 1);
        const glb = await exportAndParse(createScene({ meshes: [a, b] }));
        expect(glb.json.nodes).toHaveLength(1);
        expect(glb.json.meshes[0].primitives).toHaveLength(2);
    });
});

describe("extras", () => {
    it("exports node extras from metadata.gltf.extras", async () => {
        const node = createTransformNode("n");
        node.metadata = { gltf: { extras: { tag: "x", nested: { a: [1, 2] } } } };
        const glb = await exportAndParse(createScene({ meshes: [attach(createMesh("m"), node)] }));
        expect(glb.json.nodes[0].extras).toEqual({ tag: "x", nested: { a: [1, 2] } });
        expect(glb.json.meshes[0].extras).toBeUndefined();
    });

    it("treats a standalone mesh's extras as node extras, not mesh extras", async () => {
        const mesh = createMesh("m");
        mesh.metadata = { gltf: { extras: { k: 1 } } };
        const glb = await exportAndParse(createScene({ meshes: [mesh] }));
        expect(glb.json.nodes[0].extras).toEqual({ k: 1 });
        expect(glb.json.meshes[0].extras).toBeUndefined();
    });

    it("exports mesh extras only when they are not the same object as the owner node's", async () => {
        const shared = { from: "node" };
        const withExtras = (mesh: ReturnType<typeof createMesh>, extras: unknown) => {
            mesh.metadata = { gltf: { extras } };
            return mesh;
        };
        const holderWith = (name: string) => {
            const holder = createTransformNode(name);
            holder.metadata = { gltf: { extras: shared } };
            return holder;
        };

        const same = attach(withExtras(createMesh("a"), shared), holderWith("h1"));
        const glbSame = await exportAndParse(createScene({ meshes: [same] }));
        expect(glbSame.json.nodes[0].extras).toEqual({ from: "node" });
        expect(glbSame.json.meshes[0].extras).toBeUndefined();

        const own = attach(withExtras(createMesh("b"), { from: "mesh" }), holderWith("h2"));
        const glbOwn = await exportAndParse(createScene({ meshes: [own] }));
        expect(glbOwn.json.nodes[0].extras).toEqual({ from: "node" });
        expect(glbOwn.json.meshes[0].extras).toEqual({ from: "mesh" });

        // Two folded children: the first one whose extras differ from the node's supplies the mesh extras.
        const h3 = holderWith("h3");
        attach(withExtras(createMesh("c"), shared), h3);
        const d = attach(withExtras(createMesh("d"), { from: "second" }), h3);
        const glbBoth = await exportAndParse(createScene({ meshes: [d] }));
        expect(glbBoth.json.meshes).toHaveLength(1);
        expect(glbBoth.json.meshes[0].primitives).toHaveLength(2);
        expect(glbBoth.json.meshes[0].extras).toEqual({ from: "second" });
    });

    it("exports material extras", async () => {
        const material = createPbrMaterial({});
        material.metadata = { gltf: { extras: { grade: "A" } } };
        const glb = await exportAndParse(createScene({ meshes: [createMesh("m", { material })] }));
        expect(glb.json.materials[0].extras).toEqual({ grade: "A" });
    });

    it("drops non-JSON-serializable extras with a warning", async () => {
        const node = createTransformNode("big");
        node.metadata = { gltf: { extras: { value: BigInt(1) } } };
        const glb = await exportAndParse(createScene({ meshes: [attach(createMesh("m"), node)] }));
        expect(glb.json.nodes[0].extras).toBeUndefined();
        expect(glb.warnings).toContain('Extras of "big" are not JSON-serializable; exporting without them.');
    });

    it("snapshots extras so later edits do not reach the output", async () => {
        const extras = { v: 1 };
        const mesh = createMesh("m");
        mesh.metadata = { gltf: { extras } };
        const glb = await exportAndParse(createScene({ meshes: [mesh] }));
        extras.v = 2;
        expect(glb.json.nodes[0].extras).toEqual({ v: 1 });
    });
});

describe("determinism and read-only export", () => {
    function buildScene() {
        const holder = createTransformNode("holder", 1, 2, 3, 0, SQRT1_2, 0, SQRT1_2);
        holder.metadata = { gltf: { extras: { id: 7 } } };
        const material = createPbrMaterial({});
        const a = attach(createMesh("a", { material, authoredSign: -1 }), holder);
        const b = attach(createMesh("b", { material, tangents: new Float32Array(16).fill(0.5), colors: new Float32Array(16).fill(0.25) }), holder);
        const solo = createMesh("solo");
        solo.position.set(0, 3, 0);
        const light = createPointLight([1, 1, 1], 2);
        const camera = createFreeCamera({ x: 0, y: 1, z: -5 }, { x: 0, y: 0, z: 0 });
        const mover = createTransformNode("mover");
        return { holder, a, b, solo, scene: createScene({ meshes: [a, b, solo], lights: [light], camera, animationGroups: [translationGroup("g", mover)] }) };
    }

    it("produces byte-identical output for repeated exports", async () => {
        const { scene } = buildScene();
        const first = await exportAndParse(scene);
        const second = await exportAndParse(scene);
        expect(second.bytes).toEqual(first.bytes);
        // And across two independently built but identical scenes.
        const third = await exportAndParse(buildScene().scene);
        expect(third.bytes).toEqual(first.bytes);
    });

    it("does not modify the scene or its typed arrays", async () => {
        const { holder, a, b, solo, scene } = buildScene();
        const snapshot = () =>
            JSON.stringify(
                [a, b, solo].map((m) => ({
                    positions: Array.from(m._cpuPositions!),
                    normals: Array.from(m._cpuNormals!),
                    uvs: Array.from(m._cpuUvs!),
                    tangents: m._cpuTangents ? Array.from(m._cpuTangents) : null,
                    colors: m._cpuColors ? Array.from(m._cpuColors) : null,
                    indices: Array.from(m._cpuIndices!),
                    trs: [m.position.x, m.position.y, m.position.z, m.rotationQuaternion.x, m.rotationQuaternion.w, m.scaling.x],
                }))
            ) +
            JSON.stringify([holder.position.x, holder.position.y, holder.position.z, holder.rotationQuaternion.y, holder.rotationQuaternion.w, holder.scaling.x, holder.metadata]);
        const buffers = [a, b, solo].flatMap((m) => [m._cpuPositions!, m._cpuNormals!, m._cpuUvs!, m._cpuIndices!]);
        const bytesBefore = buffers.map((x) => new Uint8Array(x.buffer.slice(0)));
        const before = snapshot();
        await exportAndParse(scene);
        expect(snapshot()).toBe(before);
        buffers.forEach((x, i) => expect(new Uint8Array(x.buffer)).toEqual(bytesBefore[i]));
    });
});
