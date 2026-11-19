import { describe, expect, it } from "vitest";

import { evaluateAnimationTrack, getAnimationGroupTracks, setAnimationTrackKeys } from "../../../packages/babylon-lite/src/animation/animation-curve-editing";
import { createAnimationGroups, goToFrame } from "../../../packages/babylon-lite/src/animation/animation-group";
import { createAnimationManager, updateAnimationManager } from "../../../packages/babylon-lite/src/animation/animation-manager";
import { createPropertyAnimationClip, createPropertyAnimationGroup } from "../../../packages/babylon-lite/src/animation/property-animation";
import { INTERP_CUBICSPLINE, INTERP_LINEAR, INTERP_STEP, PATH_POINTER, PATH_WEIGHTS } from "../../../packages/babylon-lite/src/animation/types";
import { enablePropertyAnimationBlending } from "../../../packages/babylon-lite/src/animation/weighted-pointer-mixer";
import { parseAnimationData } from "../../../packages/babylon-lite/src/loader-gltf/gltf-animation";
import { createSceneNode } from "../../../packages/babylon-lite/src/scene/scene-node";
import type { AnimationClip, AnimationSampler, GltfAnimationData } from "../../../packages/babylon-lite/src/animation/types";

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
    it("preserves shared property clips by default and detaches only when requested", () => {
        const { manager, target, clip, group } = propertyGroup();
        const secondTarget = { value: 0 };
        const second = createPropertyAnimationGroup(manager, secondTarget, clip, { loop: false, fromTime: 0.25, toTime: 0.75 });
        const snapshot = getAnimationGroupTracks(group);
        expect(snapshot[0]).toMatchObject({ target: { target, path: "value" }, interpolation: "linear", componentCount: 1, quaternion: false });
        (snapshot[0]!.keys[0]!.value as number[])[0] = 100;
        expect(getAnimationGroupTracks(group)[0]!.keys[0]!.value).toEqual([0]);
        setAnimationTrackKeys(group, 0, [
            { time: 0, value: [2] },
            { time: 0.5, value: [8] },
            { time: 1, value: [10] },
        ]);
        expect(getAnimationGroupTracks(second)[0]!.keys).toHaveLength(3);
        expect(group.duration).toBe(1);
        updateAnimationManager(manager, 250);
        expect(target.value).toBeCloseTo(5);
        expect(secondTarget.value).toBeCloseTo(8);
        goToFrame(group, group.frameRate! / 2);
        expect(target.value).toBeCloseTo(8);
        setAnimationTrackKeys(group, 0, [{ time: 0, value: [7] }], { detachPropertyTrack: true });
        goToFrame(group, group.frameRate! / 2);
        expect(target.value).toBe(7);
        expect(getAnimationGroupTracks(second)[0]!.keys).toHaveLength(3);
    });

    it("exposes property easing and evaluates through the runtime sampler path", () => {
        const manager = createAnimationManager();
        const target = { value: 0 };
        const easing = (gradient: number) => gradient * gradient;
        const clip = createPropertyAnimationClip("eased", [
            {
                path: "value",
                keys: [
                    { time: 0, value: 0 },
                    { time: 1, value: 8 },
                ],
                easing,
            },
        ]);
        const group = createPropertyAnimationGroup(manager, target, clip, { loop: false });

        expect(getAnimationGroupTracks(group)[0]!.easing).toBe(easing);
        expect(evaluateAnimationTrack(group, 0, 0.5)).toEqual([2]);
    });

    it("uses the property evaluator for uneased STEP boundaries", () => {
        const manager = createAnimationManager();
        const target = { value: 0 };
        const clip = createPropertyAnimationClip("step", [
            {
                path: "value",
                interpolation: "step",
                keys: [
                    { time: 0, value: 0 },
                    { time: 0.1, value: 1 },
                    { time: 0.2, value: 2 },
                ],
            },
        ]);
        const group = createPropertyAnimationGroup(manager, target, clip, { loop: false });
        expect(group._propertyMixer![0][0]!.sampler.interpolation).toBe(INTERP_STEP);

        goToFrame(group, 0.1 * group.frameRate!);
        expect(evaluateAnimationTrack(group, 0, 0.1)).toEqual([target.value]);
        expect(target.value).toBe(1);
    });

    it("evaluates one glTF track without inspecting unrelated channels", () => {
        const validSampler = { input: new Float32Array([0, 1]), output: new Float32Array([0, 1]), interpolation: INTERP_LINEAR } satisfies AnimationSampler;
        const clip: AnimationClip = {
            name: "direct",
            duration: 1,
            frameRate: 60,
            samplers: [validSampler],
            channels: [
                { samplerIdx: 0, nodeIdx: 0, path: PATH_WEIGHTS },
                { samplerIdx: 99, nodeIdx: 0, path: PATH_WEIGHTS },
            ],
        };
        const group = createAnimationGroups({ clips: [clip], nodes: [], skeletons: [], morphBindings: [], nodeTargets: [], excludedNodeIndices: new Set(), nodeNames: [] })[0]!;

        expect(evaluateAnimationTrack(group, 0, 0.5)).toEqual([0.5]);
        expect(() => getAnimationGroupTracks(group)).toThrow(/invalid channel/);
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
                { input: new Float32Array([0, 1]), output: new Float32Array([0, 1, 2, 3]), interpolation: INTERP_LINEAR },
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
        expect(evaluateAnimationTrack(group, 0, 0.5)).toEqual([1]);
        setAnimationTrackKeys(group, 0, [
            { time: 0, value: [4], inTangent: [5], outTangent: [6] },
            { time: 1, value: [7], inTangent: [8], outTangent: [9] },
        ]);
        expect(Array.from(clip.samplers[0]!.output)).toEqual([5, 4, 6, 8, 7, 9]);
        goToFrame(group, group.frameRate! / 2);
        expect(pointerValue).toBeCloseTo(5.25);
        expect(() => setAnimationTrackKeys(group, 0, [{ time: 0, value: [0] }])).toThrow();
    });

    it("reports samplers referenced by multiple glTF channels", () => {
        const sampler = { input: new Float32Array([0, 1]), output: new Float32Array([0, 1]), interpolation: INTERP_LINEAR } satisfies AnimationSampler;
        const clip: AnimationClip = {
            name: "shared",
            duration: 1,
            frameRate: 60,
            samplers: [sampler],
            channels: [
                { samplerIdx: 0, nodeIdx: 0, path: PATH_WEIGHTS },
                { samplerIdx: 0, nodeIdx: 0, path: PATH_WEIGHTS },
            ],
        };
        const data: GltfAnimationData = { clips: [clip], nodes: [], skeletons: [], morphBindings: [], nodeTargets: [], excludedNodeIndices: new Set(), nodeNames: [] };
        const tracks = getAnimationGroupTracks(createAnimationGroups(data)[0]!);

        expect(tracks.map((track) => track.sharedSampler)).toEqual([true, true]);
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
