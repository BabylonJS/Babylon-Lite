/**
 * glTF `camera` node property (`_gltf_camera` feature) — perspective/orthographic mapping,
 * node-hierarchy parenting, and the two RH→LH/scale corrections.
 *
 * Root-cause background (see gltf-feature-camera.ts):
 * 1. `load-gltf.ts` builds the node hierarchy under a synthetic `__root__` whose
 *    `scale.x = -1` performs the engine's single RH→LH conversion. That mirror is correct
 *    for mesh winding but flips a camera's chirality, so the feature inserts a `fixupNode`
 *    (scale.x negated) between the source node and the camera to cancel it back out. The
 *    determinant assertions below are the regression guard: without the fix,
 *    `mat4Determinant3(cam.worldMatrix)` would be negative (a mirrored, inside-out view).
 * 2. `camera.ts`'s `getViewMatrix` derives the view matrix as a plain transpose of the
 *    camera's world-matrix rotation, which is only equivalent to the true inverse at UNIT
 *    scale. `fixupNode` also cancels the camera node's accumulated (rest-pose) scale for
 *    exactly this reason — the "cancels a uniformly-scaled ancestor" test below is the
 *    regression guard for that fix.
 */
import { describe, expect, it } from "vitest";

import feature, { enableGltfCameras } from "../../../packages/babylon-lite/src/loader-gltf/gltf-feature-camera.js";
import type { GltfLoadCtx } from "../../../packages/babylon-lite/src/loader-gltf/gltf-feature.js";
import { createTransformNode } from "../../../packages/babylon-lite/src/scene/transform-node.js";
import { mat4Determinant3 } from "../../../packages/babylon-lite/src/math/mat4-determinant3.js";
import { buildParentMap } from "../../../packages/babylon-lite/src/loader-gltf/gltf-parser.js";
import { loadGltfFeatures } from "../../../packages/babylon-lite/src/loader-gltf/gltf-feature-registry.js";
import { _appendEnabledGltfFeatures, _hasEnabledGltfFeature } from "../../../packages/babylon-lite/src/loader-gltf/gltf-feature-hooks.js";
import type { Mat4 } from "../../../packages/babylon-lite/src/math/types.js";

function makeCtx(json: unknown, nodeMap: (ReturnType<typeof createTransformNode> | undefined)[]): GltfLoadCtx {
    return {
        _json: json,
        _nodeMap: nodeMap,
        _parentMap: new Map(),
        _worldMatrixCache: new Map(),
    } as unknown as GltfLoadCtx;
}

describe("_gltf_camera feature", () => {
    it("loads only when camera import is explicitly enabled", async () => {
        const json = { nodes: [{ camera: 0 }], cameras: [{ type: "perspective", perspective: { yfov: 1, znear: 0.1 } }] };
        expect(_hasEnabledGltfFeature(json)).toBe(false);
        enableGltfCameras();
        expect(_hasEnabledGltfFeature(json)).toBe(true);
        const features = await loadGltfFeatures(json);
        _appendEnabledGltfFeatures(json, features);
        expect(features.some((candidate) => candidate.id === "_gltf_camera")).toBe(true);
    });

    it("returns {} when the asset declares no cameras", async () => {
        const ctx = makeCtx({ nodes: [{}] }, [undefined]);
        const result = await feature.applyAsset!([], createTransformNode("root"), ctx);
        expect(result.cameras).toBeUndefined();
    });

    it("maps a perspective camera's fov/near/far and inherits the source node's world position", async () => {
        // __root__ mirror (scale.x = -1), matching load-gltf.ts's buildNodeHierarchy exactly.
        const root = createTransformNode("__root__", 0, 0, 0, 0, 0, 0, 1, -1, 1, 1);
        const camNode = createTransformNode("camNode", 1, 2, 3, 0, 0, 0, 1, 1, 1, 1);
        camNode.parent = root;

        const json = {
            nodes: [{}, { camera: 0, name: "camNode" }],
            cameras: [{ type: "perspective", perspective: { yfov: 1.1, znear: 0.25, zfar: 500 } }],
        };
        const ctx = makeCtx(json, [undefined, camNode]);

        const result = await feature.applyAsset!([], root, ctx);
        expect(result.cameras).toHaveLength(1);
        const cam = result.cameras![0]!;
        expect(cam.name).toBe("camera0");
        expect(cam.fov).toBeCloseTo(1.1);
        expect(cam.nearPlane).toBeCloseTo(0.25);
        expect(cam.farPlane).toBeCloseTo(500);

        // World position matches camNode's world position: the __root__ mirror flips X.
        const w = cam.worldMatrix;
        expect(w[12]).toBeCloseTo(-1);
        expect(w[13]).toBeCloseTo(2);
        expect(w[14]).toBeCloseTo(3);

        // The mirrorFix cancels the inherited RH→LH mirror: the camera's own world basis
        // must be a PROPER rotation (positive determinant), not a mirrored one.
        expect(mat4Determinant3(w)).toBeGreaterThan(0);
    });

    it("substitutes a large far plane when a perspective camera omits zfar (glTF 'infinite' projection)", async () => {
        const root = createTransformNode("__root__", 0, 0, 0, 0, 0, 0, 1, -1, 1, 1);
        const camNode = createTransformNode("camNode");
        camNode.parent = root;
        const json = {
            nodes: [{}, { camera: 0 }],
            cameras: [{ type: "perspective", perspective: { yfov: 0.8, znear: 1 } }],
        };
        const ctx = makeCtx(json, [undefined, camNode]);
        const result = await feature.applyAsset!([], root, ctx);
        expect(result.cameras![0]!.farPlane).toBeGreaterThan(1000);
    });

    it("keeps an orthographic camera's projection parameters in glTF units under inherited scale", async () => {
        const root = createTransformNode("__root__", 0, 0, 0, 0, 0, 0, 1, -1, 1, 1);
        const camNode = createTransformNode("camNode", 0, 0, 0, 0, 0, 0, 1, 0.25, 0.25, 0.25);
        camNode.parent = root;
        const json = {
            nodes: [{}, { camera: 0, scale: [0.25, 0.25, 0.25] }],
            cameras: [{ type: "orthographic", orthographic: { xmag: 2, ymag: 3, znear: 0.5, zfar: 50 } }],
        };
        const ctx = makeCtx(json, [undefined, camNode]);
        const result = await feature.applyAsset!([], root, ctx);
        const cam = result.cameras![0]!;
        expect(cam.nearPlane).toBeCloseTo(0.5);
        expect(cam.farPlane).toBeCloseTo(50);
        expect(cam.ortho).toBeTruthy();
        expect(cam.ortho!.left).toBeCloseTo(-2);
        expect(cam.ortho!.right).toBeCloseTo(2);
        expect(cam.ortho!.bottom).toBeCloseTo(-3);
        expect(cam.ortho!.top).toBeCloseTo(3);
    });

    it("bakes the world transform when the camera's node is unreachable from any scene root", async () => {
        // Node 1 is not listed under any scene root and has no entry in _nodeMap, but IS
        // present in _parentMap so computeNodeWorldMatrix can resolve its transform directly.
        const json = {
            nodes: [{ translation: [5, 0, 0] }, { camera: 0, translation: [0, 7, 0] }],
            cameras: [{ type: "perspective", perspective: { yfov: 0.8, znear: 0.1, zfar: 10 } }],
        };
        const parentMap = new Map<number, number>([[1, 0]]);
        const ctx = {
            _json: json,
            _nodeMap: [undefined, undefined],
            _parentMap: parentMap,
            _worldMatrixCache: new Map<number, Mat4>(),
        } as unknown as GltfLoadCtx;

        const result = await feature.applyAsset!([], createTransformNode("root"), ctx);
        expect(result.cameras).toHaveLength(1);
        // computeNodeWorldMatrix's OWN root fallback (RH_TO_LH_ROOT, scale.x = -1) applies here
        // too, so node 0's translation.x (5) flips sign, and node 1 adds its own (0,7,0) on top.
        const w = result.cameras![0]!.worldMatrix;
        expect(w[12]).toBeCloseTo(-5);
        expect(w[13]).toBeCloseTo(7);
        expect(w[14]).toBeCloseTo(0);
        expect(mat4Determinant3(w)).toBeGreaterThan(0);
    });

    it("cancels a uniformly-scaled ancestor so the camera view remains rigid (VirtualCity regression)", async () => {
        // Reproduces VirtualCity's structure: a __root__ mirror, a scaled scene-root node
        // (its own matrix carries the file's ~0.0254 uniform scale, like glTF node 0 in
        // VirtualCity.gltf), and a camera node nested a couple of levels below it. Without
        // scale cancellation, `getViewMatrix`'s transpose-as-inverse shortcut leaves
        // this ~0.0254 factor in the view matrix instead of inverting it.
        const root = createTransformNode("__root__", 0, 0, 0, 0, 0, 0, 1, -1, 1, 1);
        const SCALE = 0.0254;
        const scaledSceneRoot = createTransformNode("sceneRoot", 0, 0, 0, 0, 0, 0, 1, SCALE, SCALE, SCALE);
        scaledSceneRoot.parent = root;
        const vehicle = createTransformNode("vehicle", 100, 0, 0, 0, 0, 0, 1, 1, 1, 1);
        vehicle.parent = scaledSceneRoot;
        const camNode = createTransformNode("camNode", 0, 1, -2, 0, 0, 0, 1, 1, 1, 1);
        camNode.parent = vehicle;

        const json = {
            nodes: [
                {},
                { name: "sceneRoot", scale: [SCALE, SCALE, SCALE], children: [2] },
                { name: "vehicle", translation: [100, 0, 0], children: [3] },
                { camera: 0, translation: [0, 1, -2] },
            ],
            scenes: [{ nodes: [1] }],
            scene: 0,
            cameras: [{ type: "perspective", perspective: { yfov: 1, znear: 0.1, zfar: 100 } }],
        };
        const ctx = {
            _json: json,
            _nodeMap: [undefined, scaledSceneRoot, vehicle, camNode],
            _parentMap: buildParentMap(json),
            _worldMatrixCache: new Map<number, Mat4>(),
        } as unknown as GltfLoadCtx;

        const result = await feature.applyAsset!([], root, ctx);
        const camera = result.cameras![0]!;
        const w = camera.worldMatrix;
        const basisLen = (col: number) => Math.hypot(w[col * 4]!, w[col * 4 + 1]!, w[col * 4 + 2]!);
        expect(basisLen(0)).toBeCloseTo(1, 3);
        expect(basisLen(1)).toBeCloseTo(1, 3);
        expect(basisLen(2)).toBeCloseTo(1, 3);
        expect(mat4Determinant3(w)).toBeGreaterThan(0);

        // Position correctly reflects the scaled ancestor chain: (100,0,0) scaled by
        // 0.0254 and mirrored on X by __root__, plus the camera node's own (0,1,-2) offset
        // (also scaled, since it inherits scaledSceneRoot's 0.0254 too).
        expect(w[12]).toBeCloseTo(-100 * SCALE, 3);
        expect(w[13]).toBeCloseTo(1 * SCALE, 3);
        expect(w[14]).toBeCloseTo(-2 * SCALE, 3);
    });

    it("rejects non-uniform inherited camera scale", async () => {
        const root = createTransformNode("__root__", 0, 0, 0, 0, 0, 0, 1, -1, 1, 1);
        const camNode = createTransformNode("camNode", 0, 0, 0, 0, 0, 0, 1, 2, 1, 1);
        camNode.parent = root;
        const json = {
            nodes: [{ camera: 0, scale: [2, 1, 1] }],
            cameras: [{ type: "perspective", perspective: { yfov: 1, znear: 0.1 } }],
        };
        const ctx = makeCtx(json, [camNode]);
        await expect(feature.applyAsset!([], root, ctx)).rejects.toThrow("uniform scale");
    });
});
