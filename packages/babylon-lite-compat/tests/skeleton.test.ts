import { describe, expect, it, vi } from "vitest";
import type { Skeleton as LiteSkeleton } from "babylon-lite";

import { Quaternion, Skeleton, Vector3 } from "../src/index";
import { NullEngine } from "../src/engine/engine";
import { Mesh } from "../src/meshes/meshes";
import { Scene } from "../src/scene/scene";

function createSkeleton(nodeIndices = [0, 1]): {
    skeleton: Skeleton;
    boneMatrices: Float32Array;
    bake: ReturnType<typeof vi.fn>;
    overrides: Map<number, unknown>;
    worldOverrides: Map<number, unknown>;
} {
    const overrides = new Map<number, unknown>();
    const worldOverrides = new Map<number, unknown>();
    const boneMatrices = new Float32Array([1, 0, 0, 1]);
    const bake = vi.fn(() => {
        boneMatrices.set([1, 0, 0, 1]);
    });
    const root = { name: "root", _nodeIndex: nodeIndices[0]! };
    const hand = { name: "hand", _nodeIndex: nodeIndices[1]!, parent: root };
    const lite = {
        bones: [root, hand],
        _byName: new Map([
            ["root", root],
            ["hand", hand],
        ]),
        _overrides: overrides,
        _worldOverrides: worldOverrides,
        _bake: bake,
    } as unknown as LiteSkeleton;
    return { skeleton: Skeleton._fromLite(lite, 0), boneMatrices, bake, overrides, worldOverrides };
}

describe("loader-produced Skeleton and Bone wrappers", () => {
    it("provides stable bone lookup and forwards local pose overrides to Lite", () => {
        const { skeleton, bake, overrides } = createSkeleton();
        const hand = skeleton.getBoneByName("hand");

        expect(skeleton.name).toBe("skeleton0");
        expect(skeleton.getBoneIndexByName("hand")).toBe(1);
        expect(skeleton.getBoneByName("missing")).toBeNull();
        expect(hand).toBe(skeleton.bones[1]);
        expect(hand?.getName()).toBe("hand");
        expect(hand?.getSkeleton()).toBe(skeleton);
        expect(hand?.parent).toBe(skeleton.bones[0]);

        hand?.setPosition(new Vector3(1, 2, 3));
        hand?.setRotationQuaternion(new Quaternion(0, 0, 0, 1));
        hand?.setScale(new Vector3(2, 3, 4));

        expect(overrides.has(1)).toBe(true);
        expect(bake).toHaveBeenCalledTimes(3);
    });

    it("tracks enabled state without deforming the skeleton and returns to rest", () => {
        const { skeleton, bake, overrides } = createSkeleton();
        const hand = skeleton.bones[1]!;

        expect(hand.isEnabled()).toBe(true);
        hand.setEnabled(false);
        expect(hand.isEnabled()).toBe(false);
        expect(overrides.has(1)).toBe(false);
        hand.setPosition(new Vector3(1, 2, 3));
        hand.returnToRest();
        expect(overrides.has(1)).toBe(false);
        expect(bake).toHaveBeenCalledTimes(2);
    });

    it("preserves an evaluated non-rest pose during prepare", () => {
        const { skeleton, boneMatrices, bake } = createSkeleton();
        boneMatrices.set([1, 2, 3, 1]);
        const evaluatedPose = Array.from(boneMatrices);

        skeleton.prepare();

        expect(Array.from(boneMatrices)).toEqual(evaluatedPose);
        expect(bake).not.toHaveBeenCalled();
    });

    it("returns a stopped non-rest pose to rest even when both override maps are empty", () => {
        const { skeleton, boneMatrices, bake, overrides, worldOverrides } = createSkeleton();
        boneMatrices.set([4, 3, 2, 1]);
        expect(overrides.size).toBe(0);
        expect(worldOverrides.size).toBe(0);

        skeleton.returnToRest();

        expect(Array.from(boneMatrices)).toEqual([1, 0, 0, 1]);
        expect(overrides.size).toBe(0);
        expect(worldOverrides.size).toBe(0);
        expect(bake).toHaveBeenCalledTimes(1);
    });

    it("returns only the owning skeleton to rest when an asset shares override maps", () => {
        const sharedOverrides = new Map<number, unknown>([
            [1, { position: true }],
            [3, { position: true }],
        ]);
        const sharedWorldOverrides = new Map<number, unknown>([
            [0, { world: true }],
            [2, { world: true }],
        ]);
        const first = createSkeleton([0, 1]);
        const second = createSkeleton([2, 3]);
        Object.defineProperties(first.skeleton._lite, {
            _overrides: { value: sharedOverrides },
            _worldOverrides: { value: sharedWorldOverrides },
        });
        Object.defineProperties(second.skeleton._lite, {
            _overrides: { value: sharedOverrides },
            _worldOverrides: { value: sharedWorldOverrides },
        });

        first.skeleton.returnToRest();

        expect([...sharedOverrides.keys()]).toEqual([3]);
        expect([...sharedWorldOverrides.keys()]).toEqual([2]);
    });

    it("surfaces stable scene skeleton wrappers from loaded meshes", () => {
        const { skeleton } = createSkeleton();
        const scene = new Scene(new NullEngine());
        const liteMesh = { name: "skinned", children: [], _gpu: {}, skeleton: { _skeleton: skeleton._lite } } as never;
        Mesh._fromLite(liteMesh, undefined, scene);
        scene._lite.meshes.push(liteMesh);

        expect(scene.skeletons).toHaveLength(1);
        expect(scene.skeletons[0]!._lite).toBe(skeleton._lite);
        expect(scene.skeletons[0]).toBe(scene.skeletons[0]);
    });
});
