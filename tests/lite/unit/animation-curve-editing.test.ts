import { describe, expect, it } from "vitest";

import { getAnimationGroupTracks, setAnimationTrackKeys } from "../../../packages/babylon-lite/src/animation/animation-curve-editing";
import { createAnimationGroups, goToFrame } from "../../../packages/babylon-lite/src/animation/animation-group";
import { createAnimationManager, updateAnimationManager } from "../../../packages/babylon-lite/src/animation/animation-manager";
import { quadraticEase } from "../../../packages/babylon-lite/src/animation/easing";
import { createPropertyAnimationClip, createPropertyAnimationGroup } from "../../../packages/babylon-lite/src/animation/property-animation";
import { INTERP_CUBICSPLINE, PATH_POINTER, PATH_WEIGHTS } from "../../../packages/babylon-lite/src/animation/types";
import { enablePropertyAnimationBlending } from "../../../packages/babylon-lite/src/animation/weighted-pointer-mixer";
import { parseAnimationData } from "../../../packages/babylon-lite/src/loader-gltf/gltf-animation";
import { createSceneNode } from "../../../packages/babylon-lite/src/scene/scene-node";
import type { AnimationClip, GltfAnimationData } from "../../../packages/babylon-lite/src/animation/types";

function propertyGroup() {
    const manager = createAnimationManager();
    const target = { value: 0 };
    const clip = createPropertyAnimationClip(
        "test",
        [
            {
                path: "value",
                keys: [
                    { time: 0, value: 0 },
                    { time: 1, value: 10 },
                ],
            },
        ],
        { frameRate: 30 }
    );
    return { manager, target, clip, group: createPropertyAnimationGroup(manager, target, clip, { loop: false }) };
}

describe("animation curve editing", () => {
    it("edits shared property tracks without changing ranges, and snapshots are detached", () => {
        const { manager, target, clip, group } = propertyGroup();
        const secondTarget = { value: 0 };
        const second = createPropertyAnimationGroup(manager, secondTarget, clip, { loop: false, fromTime: 0.25, toTime: 0.75 });
        const snapshot = getAnimationGroupTracks(group);
        expect(snapshot[0]).toMatchObject({ target: { target, path: "value" }, interpolation: "linear", componentCount: 1, quaternion: false });
        expect(snapshot[0]!.easing).toBeUndefined();
        (snapshot[0]!.keys[0]!.value as number[])[0] = 100;
        expect(getAnimationGroupTracks(group)[0]!.keys[0]!.value).toEqual([0]);
        setAnimationTrackKeys(group, 0, [
            { time: 0, value: [2] },
            { time: 0.5, value: [8] },
            { time: 1, value: [10] },
        ]);
        expect(group.duration).toBe(1);
        expect(getAnimationGroupTracks(second)[0]!.keys).toHaveLength(3);
        updateAnimationManager(manager, 250);
        expect(target.value).toBeCloseTo(5);
        expect(secondTarget.value).toBeCloseTo(8);
        goToFrame(group, group.frameRate! / 2);
        expect(target.value).toBeCloseTo(8);
        setAnimationTrackKeys(group, 0, [{ time: 0, value: [7] }]);
        goToFrame(group, group.frameRate! / 2);
        expect(target.value).toBe(7);
    });

    it.each([
        { name: "built-in", easing: quadraticEase, midpoint: 4 },
        { name: "custom overshooting", easing: (gradient: number) => 3 * gradient, midpoint: 14 },
    ])("exposes $name easing for segment evaluation and preserves it after key edits", ({ easing, midpoint }) => {
        const manager = createAnimationManager();
        const target = { value: 0 };
        const clip = createPropertyAnimationClip("eased", [
            {
                path: "value",
                easing,
                keys: [
                    { time: 0, value: -10 },
                    { time: 2, value: 2 },
                    { time: 4, value: 10 },
                ],
            },
        ]);
        const group = createPropertyAnimationGroup(manager, target, clip, { loop: false });
        const track = getAnimationGroupTracks(group)[0]!;
        expect(track.easing).toBe(easing);
        const start = track.keys[1]!;
        const end = track.keys[2]!;
        const progress = (3 - start.time) / (end.time - start.time);
        const value = start.value[0]! + track.easing!(progress) * (end.value[0]! - start.value[0]!);
        expect(value).toBe(midpoint);
        goToFrame(group, 3 * group.frameRate!);
        expect(target.value).toBeCloseTo(value);
        setAnimationTrackKeys(group, 0, [
            { time: 0, value: [0] },
            { time: 4, value: [8] },
        ]);
        expect(getAnimationGroupTracks(group)[0]!.easing).toBe(easing);
        goToFrame(group, 2 * group.frameRate!);
        expect(target.value).toBeCloseTo(8 * easing(0.5));
    });

    it("exposes STEP easing without invoking it during snapshots, holds, or playback", () => {
        const manager = createAnimationManager();
        const target = { value: 0 };
        const easing = (): number => {
            throw new Error("STEP must not evaluate easing");
        };
        const clip = createPropertyAnimationClip("step", [
            {
                path: "value",
                interpolation: "step",
                easing,
                keys: [
                    { time: 0, value: 2 },
                    { time: 1, value: 10 },
                ],
            },
        ]);
        const group = createPropertyAnimationGroup(manager, target, clip, { loop: false });
        expect(getAnimationGroupTracks(group)[0]).toMatchObject({ interpolation: "step", easing });
        goToFrame(group, 0);
        expect(target.value).toBe(2);
        goToFrame(group, group.frameRate! / 2);
        expect(target.value).toBe(2);
        goToFrame(group, group.frameRate!);
        expect(target.value).toBe(10);
    });

    it("edits real parsed glTF data without mutating aliased accessors", () => {
        const buffer = new Float32Array([0, 1, 0, 0, 0, 10, 0, 0]);
        const json = {
            nodes: [{ name: "node" }],
            bufferViews: [{ byteOffset: 0 }, { byteOffset: 8 }],
            accessors: [
                { bufferView: 0, componentType: 5126, count: 2, type: "SCALAR" },
                { bufferView: 1, componentType: 5126, count: 2, type: "VEC3" },
            ],
            animations: [
                {
                    samplers: [{ input: 0, output: 1 }],
                    channels: [{ sampler: 0, target: { node: 0, path: "translation" } }],
                },
                {
                    samplers: [{ input: 0, output: 1 }],
                    channels: [{ sampler: 0, target: { node: 0, path: "translation" } }],
                },
            ],
        };
        const target = createSceneNode("node");
        const data = parseAnimationData(json, new DataView(buffer.buffer), [], new Map(), new Map(), [target]);
        expect(data).not.toBeNull();
        const [group, other] = createAnimationGroups(data!);
        expect(getAnimationGroupTracks(group!)[0]).toMatchObject({ target: { targetName: "node", path: "translation" }, componentCount: 3 });
        expect(getAnimationGroupTracks(group!)[0]!.easing).toBeUndefined();
        setAnimationTrackKeys(group!, 0, [
            { time: 0, value: [2, 0, 0] },
            { time: 1, value: [6, 0, 0] },
        ]);
        expect(Array.from(buffer)).toEqual([0, 1, 0, 0, 0, 10, 0, 0]);
        expect(getAnimationGroupTracks(other!)[0]!.keys[1]!.value).toEqual([10, 0, 0]);
        goToFrame(group!, group!.frameRate! / 2);
        expect(target.position.x).toBeCloseTo(4);
    });

    it("round-trips cubic tangents and represents pointer and morph component counts", () => {
        let pointerValue = 0;
        const clip: AnimationClip = {
            name: "curves",
            duration: 1,
            frameRate: 48,
            samplers: [
                { input: new Float32Array([0, 1]), output: new Float32Array([0, 0, 1, 1, 2, 0]), interpolation: INTERP_CUBICSPLINE },
                { input: new Float32Array([0, 1]), output: new Float32Array([0, 1, 2, 3]), interpolation: 0 },
            ],
            channels: [
                {
                    samplerIdx: 0,
                    nodeIdx: -1,
                    path: PATH_POINTER,
                    pointerArity: 1,
                    pointerWriter: (output, offset) => {
                        pointerValue = output[offset]!;
                    },
                },
                { samplerIdx: 1, nodeIdx: 0, path: PATH_WEIGHTS },
            ],
        };
        const data: GltfAnimationData = { clips: [clip], nodes: [], skeletons: [], morphBindings: [], nodeTargets: [], excludedNodeIndices: new Set(), nodeNames: [] };
        const group = createAnimationGroups(data)[0]!;
        const tracks = getAnimationGroupTracks(group);
        expect(tracks[0]!.interpolation).toBe("cubicSpline");
        expect(tracks[0]!.keys[0]).toEqual({ time: 0, value: [0], inTangent: [0], outTangent: [1] });
        expect(tracks[1]!.componentCount).toBe(2);
        setAnimationTrackKeys(group, 0, [
            { time: 0, value: [4], inTangent: [5], outTangent: [6] },
            { time: 1, value: [7], inTangent: [8], outTangent: [9] },
        ]);
        expect(Array.from(clip.samplers[0]!.output)).toEqual([5, 4, 6, 8, 7, 9]);
        goToFrame(group, group.frameRate! / 2);
        expect(pointerValue).toBeCloseTo(5.25);
        expect(() => setAnimationTrackKeys(group, 0, [{ time: 0, value: [0] }])).toThrow();
    });

    it("uses edited keys with the property blending mixer", () => {
        const { manager, target, group } = propertyGroup();
        enablePropertyAnimationBlending(manager);
        group.weight = 0.5;
        updateAnimationManager(manager, 0);
        setAnimationTrackKeys(group, 0, [
            { time: 0, value: [2] },
            { time: 1, value: [6] },
        ]);
        updateAnimationManager(manager, 500);
        expect(target.value).toBeCloseTo(2);
    });

    it("rejects invalid edits atomically and reports unsupported groups", () => {
        const { group } = propertyGroup();
        const before = getAnimationGroupTracks(group);
        for (const keys of [
            [],
            [{ time: 0, value: [1, 2] }],
            [{ time: 1.1, value: [1] }],
            [{ time: -1e-50, value: [1] }],
            [
                { time: 0, value: [1] },
                { time: 1e-50, value: [2] },
            ],
            [{ time: 0, value: [Infinity] }],
            [{ time: 0, value: [1], inTangent: [0] }],
        ]) {
            expect(() => setAnimationTrackKeys(group, 0, keys)).toThrow();
            expect(getAnimationGroupTracks(group)).toEqual(before);
        }
        expect(() => setAnimationTrackKeys(group, 3, [{ time: 0, value: [1] }])).toThrow();
        expect(() => getAnimationGroupTracks({ ...group, _propertyMixer: undefined })).toThrow(/does not expose/);
        const propertyMixer = group._propertyMixer!;
        const usdLikeGroup = { ...group, _propertyMixer: [propertyMixer[0], propertyMixer[1], propertyMixer[2], propertyMixer[3], 0] as const };
        expect(() => getAnimationGroupTracks(usdLikeGroup)).toThrow(/USD animation groups/);
        expect(() => setAnimationTrackKeys(usdLikeGroup, 0, [{ time: 0, value: [1] }])).toThrow(/USD animation groups/);
    });
});
