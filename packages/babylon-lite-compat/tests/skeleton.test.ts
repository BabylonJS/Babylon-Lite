import { describe, expect, it, vi } from "vitest";
import type { Skeleton as LiteSkeleton } from "babylon-lite";

import { Quaternion, Skeleton, Vector3 } from "../src/index";

function createSkeleton(): { skeleton: Skeleton; bake: ReturnType<typeof vi.fn>; overrides: Map<number, unknown> } {
    const bake = vi.fn();
    const overrides = new Map<number, unknown>();
    const root = { name: "root", _nodeIndex: 0 };
    const hand = { name: "hand", _nodeIndex: 1 };
    const lite = {
        bones: [root, hand],
        _byName: new Map([
            ["root", root],
            ["hand", hand],
        ]),
        _overrides: overrides,
        _worldOverrides: new Map(),
        _bake: bake,
    } as unknown as LiteSkeleton;
    return { skeleton: Skeleton._fromLite(lite, 0), bake, overrides };
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

        hand?.setPosition(new Vector3(1, 2, 3));
        hand?.setRotationQuaternion(new Quaternion(0, 0, 0, 1));
        hand?.setScale(new Vector3(2, 3, 4));

        expect(overrides.has(1)).toBe(true);
        expect(bake).toHaveBeenCalledTimes(3);
    });

    it("tracks enabled state without deforming the skeleton and returns to rest", () => {
        const { skeleton, bake, overrides } = createSkeleton();
        const hand = skeleton.bones[1]!;

        hand.setEnabled(false);
        expect(hand.isEnabled()).toBe(false);
        expect(overrides.has(1)).toBe(false);
        hand.setPosition(new Vector3(1, 2, 3));
        hand.returnToRest();
        expect(overrides.has(1)).toBe(false);
        expect(bake).toHaveBeenCalledTimes(2);
    });
});
