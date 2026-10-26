import { describe, expect, it } from "vitest";
import { attach, createMesh, createScene, expectClose, exportAndParse, loaderRoot, readAccessor, readBufferView } from "./export-test-utils";
import type { ParsedGlb } from "./export-test-utils";
import { createTransformNode } from "../../../../packages/babylon-lite/src/scene/transform-node";
import {
    INTERP_CUBICSPLINE,
    INTERP_LINEAR,
    INTERP_STEP,
    PATH_POINTER,
    PATH_ROTATION,
    PATH_SCALE,
    PATH_TRANSLATION,
    PATH_WEIGHTS,
} from "../../../../packages/babylon-lite/src/animation/types";
import type { SceneContext } from "../../../../packages/babylon-lite/src/scene/scene-core";

type AnimationGroups = SceneContext["animationGroups"];

interface SamplerSpec {
    input: number[];
    output: number[];
    interpolation?: number;
}

interface ChannelSpec {
    target: object;
    /** `targetedAnimations[].path`. */
    path: string;
    /** The clip channel's numeric path. */
    clipPath: number;
    samplerIdx: number;
}

function group(name: string, channels: ChannelSpec[], samplers: SamplerSpec[]): AnimationGroups[number] {
    const clip = {
        name,
        channels: channels.map((c, i) => ({ samplerIdx: c.samplerIdx, nodeIdx: i, path: c.clipPath })),
        samplers: samplers.map((s) => ({ input: new Float32Array(s.input), output: new Float32Array(s.output), interpolation: s.interpolation ?? INTERP_LINEAR })),
        duration: 1,
    };
    return { name, targetedAnimations: channels.map((c) => ({ target: c.target, path: c.path })), _gltfMixer: [clip, [], []] } as unknown as AnimationGroups[number];
}

const channel = (target: object, path: "translation" | "rotation" | "scale" | "weights", samplerIdx = 0): ChannelSpec => ({
    target,
    path,
    clipPath: { translation: PATH_TRANSLATION, rotation: PATH_ROTATION, scale: PATH_SCALE, weights: PATH_WEIGHTS }[path],
    samplerIdx,
});

const exportGroups = (groups: AnimationGroups, extra: Partial<Parameters<typeof createScene>[0]> = {}): Promise<ParsedGlb> =>
    exportAndParse(createScene({ animationGroups: groups, ...extra }));

/** Unit quaternions (xyzw), so rotation tests exercise conversion rather than renormalization. */
const UNIT_A: [number, number, number, number] = [0.1, 0.2, 0.3, Math.sqrt(1 - 0.14)];
const UNIT_B: [number, number, number, number] = [-0.4, 0.5, 0.6, Math.sqrt(1 - 0.77)];

describe("animations", () => {
    it("emits one glTF animation per _gltfMixer group and warns for groups without one", async () => {
        const a = createTransformNode("a");
        const b = createTransformNode("b");
        const propertyGroup = { name: "props", targetedAnimations: [{ target: a, path: "position" }] } as unknown as AnimationGroups[number];
        const glb = await exportGroups([
            group("first", [channel(a, "translation")], [{ input: [0, 1], output: [0, 0, 0, 1, 1, 1] }]),
            propertyGroup,
            group("second", [channel(b, "scale")], [{ input: [0, 1], output: [1, 1, 1, 2, 2, 2] }]),
        ]);
        expect(glb.json.animations.map((x: { name: string }) => x.name)).toEqual(["first", "second"]);
        expect(glb.warnings).toContain('Animation group "props" has no glTF-clip data; skipping.');
    });

    it("negates translation X on converting values and CUBICSPLINE tangents", async () => {
        const a = createTransformNode("a");
        const b = createTransformNode("b");
        const glb = await exportGroups([
            group(
                "g",
                [channel(a, "translation", 0), channel(b, "translation", 1)],
                [
                    { input: [0, 1], output: [1, 2, 3, -4, 5, 6] },
                    // in-tangent, value, out-tangent per key
                    { input: [0, 1], output: [1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6], interpolation: INTERP_CUBICSPLINE },
                ]
            ),
        ]);
        const samplers = glb.json.animations[0].samplers;
        expectClose(readAccessor(glb, samplers[0].output), [-1, 2, 3, 4, 5, 6]);
        expectClose(readAccessor(glb, samplers[1].output), [-1, 1, 1, -2, 2, 2, -3, 3, 3, -4, 4, 4, -5, 5, 5, -6, 6, 6]);
        expect(glb.json.accessors[samplers[0].output]).toMatchObject({ type: "VEC3", count: 2 });
        expect(glb.json.accessors[samplers[1].output]).toMatchObject({ type: "VEC3", count: 6 });
    });

    it("maps converting rotations with (x, -y, -z, w), including CUBICSPLINE tangents", async () => {
        const a = createTransformNode("a");
        const b = createTransformNode("b");
        const glb = await exportGroups([
            group(
                "g",
                [channel(a, "rotation", 0), channel(b, "rotation", 1)],
                [
                    { input: [0, 1], output: [...UNIT_A, ...UNIT_B] },
                    { input: [0, 1], output: [0.1, 0.2, 0.3, 0.4, 1, 2, 3, 4, 5, 6, 7, 8, 0.1, 0.2, 0.3, 0.4, 9, 8, 7, 6, 5, 4, 3, 2], interpolation: INTERP_CUBICSPLINE },
                ]
            ),
        ]);
        const samplers = glb.json.animations[0].samplers;
        expectClose(readAccessor(glb, samplers[0].output), [UNIT_A[0], -UNIT_A[1], -UNIT_A[2], UNIT_A[3], UNIT_B[0], -UNIT_B[1], -UNIT_B[2], UNIT_B[3]]);
        expectClose(readAccessor(glb, samplers[1].output), [0.1, -0.2, -0.3, 0.4, 1, -2, -3, 4, 5, -6, -7, 8, 0.1, -0.2, -0.3, 0.4, 9, -8, -7, 6, 5, -4, -3, 2]);
        expect(glb.json.accessors[samplers[0].output].type).toBe("VEC4");
    });

    it("leaves converting scale and weights values unchanged", async () => {
        const node = createTransformNode("a");
        const mesh = createMesh("m", {
            extra: { morphTargets: { targets: [{ positions: new Float32Array(12), normals: null }], weights: new Float32Array([0]), count: 1 } },
        });
        const glb = await exportGroups(
            [
                group(
                    "g",
                    [channel(node, "scale", 0), channel(mesh, "weights", 1)],
                    [
                        { input: [0, 1], output: [1, 2, 3, 4, 5, 6] },
                        { input: [0, 1], output: [0, 1] },
                    ]
                ),
            ],
            { meshes: [mesh] }
        );
        const animation = glb.json.animations[0];
        expectClose(readAccessor(glb, animation.samplers[0].output), [1, 2, 3, 4, 5, 6]);
        expectClose(readAccessor(glb, animation.samplers[1].output), [0, 1]);
        expect(glb.json.accessors[animation.samplers[1].output].type).toBe("SCALAR");
        expect(animation.channels.map((c: { target: { path: string } }) => c.target.path)).toEqual(["scale", "weights"]);
    });

    it("exports pass-through targets with byte-identical sampler data", async () => {
        const root = loaderRoot();
        const node = attach(createTransformNode("n"), root);
        const translation = new Float32Array([1, 2, 3, -4, 5, 6]);
        const rotation = new Float32Array([...UNIT_A, ...UNIT_B]);
        const animationGroup = group(
            "g",
            [channel(node, "translation", 0), channel(node, "rotation", 1)],
            [
                { input: [0, 1], output: Array.from(translation) },
                { input: [0, 1], output: Array.from(rotation) },
            ]
        );
        const glb = await exportGroups([animationGroup]);
        const samplers = glb.json.animations[0].samplers;
        const bytesOf = (accessor: number) => {
            const a = glb.json.accessors[accessor];
            return Array.from(readBufferView(glb, a.bufferView).subarray(a.byteOffset ?? 0, (a.byteOffset ?? 0) + a.count * (a.type === "VEC4" ? 16 : 12)));
        };
        const expected = (f: Float32Array) => Array.from(new Uint8Array(f.buffer));
        expect(bytesOf(samplers[0].output)).toEqual(expected(translation));
        expect(bytesOf(samplers[1].output)).toEqual(expected(rotation));
    });

    it("renormalizes non-unit LINEAR and STEP rotation keys in the converting pass", async () => {
        const a = createTransformNode("a");
        const b = createTransformNode("b");
        const glb = await exportGroups([
            group(
                "g",
                [channel(a, "rotation", 0), channel(b, "rotation", 1)],
                [
                    { input: [0, 1], output: [0, 0, 0, 2, 0.2, 0.4, 0.4, 0.8] },
                    { input: [0, 1], output: [0, 0, 0, 0.5, 0, 0, 3, 4], interpolation: INTERP_STEP },
                ]
            ),
        ]);
        const [linear, step] = glb.json.animations[0].samplers;
        // Mirrored (x, -y, -z, w), then divided by the length.
        expectClose(readAccessor(glb, linear.output), [0, 0, 0, 1, 0.2 / 1, -0.4, -0.4, 0.8]);
        expectClose(readAccessor(glb, step.output), [0, 0, 0, 1, 0, 0, -0.6, 0.8]);
    });

    it("renormalizes non-unit rotation keys in the pass-through pass and leaves unit keys byte-identical", async () => {
        const root = loaderRoot();
        const node = attach(createTransformNode("n"), root);
        const unit = new Float32Array([...UNIT_A]);
        const glb = await exportGroups([group("g", [channel(node, "rotation", 0)], [{ input: [0, 1, 2], output: [...unit, 0, 0, 3, 4, 0, 0, 0, 0.5] }])]);
        const out = readAccessor(glb, glb.json.animations[0].samplers[0].output);
        expect(out.slice(0, 4)).toEqual(Array.from(unit));
        expectClose(out.slice(4, 8), [0, 0, 0.6, 0.8]);
        expectClose(out.slice(8, 12), [0, 0, 0, 1]);
    });

    it("keeps keys within 0.0005 of unit length unchanged", async () => {
        const root = loaderRoot();
        const node = attach(createTransformNode("n"), root);
        const nearUnit = new Float32Array([0, 0, 0, 1.0004]);
        const glb = await exportGroups([group("g", [channel(node, "rotation", 0)], [{ input: [0], output: Array.from(nearUnit) }])]);
        expect(readAccessor(glb, glb.json.animations[0].samplers[0].output)).toEqual(Array.from(nearUnit));
    });

    it("does not renormalize CUBICSPLINE rotation values or tangents", async () => {
        const root = loaderRoot();
        const node = attach(createTransformNode("n"), root);
        const output = [1, 1, 1, 1, 2, 0, 0, 0, 3, 3, 3, 3, 4, 4, 4, 4, 5, 0, 0, 0, 6, 6, 6, 6];
        const glb = await exportGroups([group("g", [channel(node, "rotation", 0)], [{ input: [0, 1], output, interpolation: INTERP_CUBICSPLINE }])]);
        expect(readAccessor(glb, glb.json.animations[0].samplers[0].output)).toEqual(output);
    });

    it("skips a channel whose sampler has no keys", async () => {
        const a = createTransformNode("a");
        const b = createTransformNode("b");
        const glb = await exportGroups([
            group(
                "g",
                [channel(a, "translation", 0), channel(b, "translation", 1)],
                [
                    { input: [], output: [] },
                    { input: [0, 1], output: [0, 0, 0, 1, 1, 1] },
                ]
            ),
        ]);
        expect(glb.warnings).toContain('Animation "g" has a sampler whose key and value counts do not match; skipping channel.');
        expect(glb.json.animations[0].channels).toHaveLength(1);
        expect(glb.json.animations[0].channels[0].target.node).toBe(1);
    });

    it("skips a channel whose output length does not match keys x components", async () => {
        const a = createTransformNode("a");
        const b = createTransformNode("b");
        const c = createTransformNode("c");
        const glb = await exportGroups([
            group(
                "g",
                [channel(a, "translation", 0), channel(b, "rotation", 1), channel(c, "scale", 2)],
                [
                    { input: [0, 1], output: [0, 0, 0, 1, 1] },
                    { input: [0, 1], output: [0, 0, 0, 1, 0, 0, 0] },
                    { input: [0, 1], output: [1, 1, 1, 2, 2, 2] },
                ]
            ),
        ]);
        // Identical warnings are logged once.
        expect(glb.warnings.filter((w) => w.includes("key and value counts do not match"))).toHaveLength(1);
        expect(glb.json.animations[0].channels).toHaveLength(1);
        expect(glb.json.animations[0].channels[0].target.path).toBe("scale");
    });

    it("requires three outputs per key for CUBICSPLINE", async () => {
        const a = createTransformNode("a");
        const b = createTransformNode("b");
        const glb = await exportGroups([
            group(
                "g",
                [channel(a, "translation", 0), channel(b, "translation", 1)],
                [
                    // Two keys need 2 * 3 * 3 = 18 values; a plain 6 is wrong for a spline.
                    { input: [0, 1], output: [0, 0, 0, 1, 1, 1], interpolation: INTERP_CUBICSPLINE },
                    { input: [0, 1], output: new Array(18).fill(1), interpolation: INTERP_CUBICSPLINE },
                ]
            ),
        ]);
        expect(glb.warnings.filter((w) => w.includes("key and value counts do not match"))).toHaveLength(1);
        expect(glb.json.animations[0].channels.map((c: { target: { node: number } }) => c.target.node)).toEqual([1]);
    });

    it("requires one output per key and morph target for weights", async () => {
        const target = (): { positions: Float32Array; normals: null } => ({ positions: new Float32Array(12), normals: null });
        const mesh = createMesh("m", { extra: { morphTargets: { targets: [target(), target()], weights: new Float32Array([0, 0]), count: 2 } } });
        const other = createMesh("o", { extra: { morphTargets: { targets: [target(), target()], weights: new Float32Array([0, 0]), count: 2 } } });
        const glb = await exportGroups(
            [
                group(
                    "g",
                    [channel(mesh, "weights", 0), channel(other, "weights", 1)],
                    [
                        // One value per key matches a single target only.
                        { input: [0, 1], output: [0, 1] },
                        { input: [0, 1], output: [0, 0, 1, 1] },
                    ]
                ),
            ],
            { meshes: [mesh, other] }
        );
        expect(glb.warnings.filter((w) => w.includes("key and value counts do not match"))).toHaveLength(1);
        expect(glb.json.animations[0].channels).toHaveLength(1);
        expect(glb.json.animations[0].channels[0].target.node).toBe(1);
        expect(readAccessor(glb, glb.json.animations[0].samplers[0].output)).toEqual([0, 0, 1, 1]);
    });

    it("writes input accessor min and max", async () => {
        const node = createTransformNode("a");
        const glb = await exportGroups([group("g", [channel(node, "translation")], [{ input: [0.5, 1, 2.5], output: [0, 0, 0, 1, 1, 1, 2, 2, 2] }])]);
        const input = glb.json.accessors[glb.json.animations[0].samplers[0].input];
        expect(input).toMatchObject({ type: "SCALAR", componentType: 5126, count: 3, min: [0.5], max: [2.5] });
        expect(readAccessor(glb, glb.json.animations[0].samplers[0].input)).toEqual([0.5, 1, 2.5]);
    });

    it("writes STEP and CUBICSPLINE interpolation and omits LINEAR", async () => {
        const a = createTransformNode("a");
        const b = createTransformNode("b");
        const c = createTransformNode("c");
        const glb = await exportGroups([
            group(
                "g",
                [channel(a, "translation", 0), channel(b, "translation", 1), channel(c, "translation", 2)],
                [
                    { input: [0, 1], output: [0, 0, 0, 1, 1, 1], interpolation: INTERP_STEP },
                    { input: [0, 1], output: new Array(18).fill(1), interpolation: INTERP_CUBICSPLINE },
                    { input: [0, 1], output: [0, 0, 0, 1, 1, 1], interpolation: INTERP_LINEAR },
                ]
            ),
        ]);
        const samplers = glb.json.animations[0].samplers;
        expect(samplers.map((s: { interpolation?: string }) => s.interpolation)).toEqual(["STEP", "CUBICSPLINE", undefined]);
        expect("interpolation" in samplers[2]).toBe(false);
    });

    it("skips pointer channels with a warning", async () => {
        const node = createTransformNode("a");
        const glb = await exportGroups([
            group(
                "g",
                [{ target: node, path: "pointer", clipPath: PATH_POINTER, samplerIdx: 0 }, channel(node, "translation", 1)],
                [
                    { input: [0, 1], output: [0, 1] },
                    { input: [0, 1], output: [0, 0, 0, 1, 1, 1] },
                ]
            ),
        ]);
        expect(glb.warnings).toContain('KHR_animation_pointer channel in "g" is skipped on export.');
        expect(glb.json.animations[0].channels).toHaveLength(1);
        expect(glb.json.animations[0].channels[0].target.path).toBe("translation");
    });

    it("skips a channel whose target is not exported", async () => {
        const node = createTransformNode("a");
        const stranger = { name: "not a node" };
        const glb = await exportGroups([
            group(
                "g",
                [{ target: stranger, path: "translation", clipPath: PATH_TRANSLATION, samplerIdx: 0 }, channel(node, "translation", 1)],
                [
                    { input: [0, 1], output: [0, 0, 0, 1, 1, 1] },
                    { input: [0, 1], output: [2, 2, 2, 3, 3, 3] },
                ]
            ),
        ]);
        expect(glb.warnings).toContain("Animation channel target (node 0) is not in the exported scene; skipping channel.");
        expect(glb.json.animations[0].channels).toHaveLength(1);
        expect(glb.json.animations[0].channels[0].target.node).toBe(0);
    });

    it("skips a duplicate (node, path) channel", async () => {
        const node = createTransformNode("a");
        const glb = await exportGroups([
            group(
                "g",
                [channel(node, "translation", 0), channel(node, "translation", 1)],
                [
                    { input: [0, 1], output: [0, 0, 0, 1, 1, 1] },
                    { input: [0, 1], output: [5, 5, 5, 6, 6, 6] },
                ]
            ),
        ]);
        expect(glb.json.animations[0].channels).toHaveLength(1);
        expectClose(readAccessor(glb, glb.json.animations[0].samplers[glb.json.animations[0].channels[0].sampler].output), [0, 0, 0, -1, 1, 1]);
        expect(glb.warnings.some((w) => w.includes("more than once"))).toBe(true);
    });

    it("skips a weights channel on a node without morph targets", async () => {
        const node = createTransformNode("a");
        const plain = createMesh("plain");
        const glb = await exportGroups(
            [
                group(
                    "g",
                    [channel(node, "weights", 0), channel(plain, "weights", 0), channel(node, "translation", 1)],
                    [
                        { input: [0, 1], output: [0, 1] },
                        { input: [0, 1], output: [0, 0, 0, 1, 1, 1] },
                    ]
                ),
            ],
            { meshes: [plain] }
        );
        expect(glb.json.animations[0].channels.map((c: { target: { path: string } }) => c.target.path)).toEqual(["translation"]);
        expect(glb.warnings.filter((w) => w.includes("morph weights on a node without morph targets"))).toHaveLength(1);
    });

    it("deduplicates samplers shared by several channels", async () => {
        const a = createTransformNode("a");
        const b = createTransformNode("b");
        const glb = await exportGroups([group("g", [channel(a, "translation", 0), channel(b, "translation", 0)], [{ input: [0, 1], output: [0, 0, 0, 1, 1, 1] }])]);
        const animation = glb.json.animations[0];
        expect(animation.samplers).toHaveLength(1);
        expect(animation.channels.map((c: { sampler: number }) => c.sampler)).toEqual([0, 0]);
        expect(animation.channels.map((c: { target: { node: number } }) => c.target.node)).toEqual([0, 1]);
        // The shared input/output arrays also share their accessors.
        expect(glb.json.accessors.filter((x: { type: string; count: number }) => x.type === "SCALAR" && x.count === 2)).toHaveLength(1);
    });

    it("drops an animation with no surviving channel", async () => {
        const node = createTransformNode("a");
        const glb = await exportGroups([
            group("allPointers", [{ target: node, path: "pointer", clipPath: PATH_POINTER, samplerIdx: 0 }], [{ input: [0, 1], output: [0, 1] }]),
            group("orphans", [{ target: { name: "x" }, path: "translation", clipPath: PATH_TRANSLATION, samplerIdx: 0 }], [{ input: [0, 1], output: [0, 0, 0, 1, 1, 1] }]),
        ]);
        expect(glb.json.animations).toBeUndefined();
    });

    it("never folds a mesh bound by a clip channel, whatever the group's string path says", async () => {
        const holder = createTransformNode("holder");
        const bound = attach(createMesh("bound"), holder);
        // Animated nodes are detected from the clip channel's numeric path, so the mesh keeps its own
        // node (a folded mesh would have no node for the channel to target).
        const glb = await exportGroups(
            [group("g", [{ target: bound, path: "visibility", clipPath: PATH_TRANSLATION, samplerIdx: 0 }], [{ input: [0, 1], output: [0, 0, 0, 1, 1, 1] }])],
            { meshes: [bound] }
        );
        expect(glb.json.nodes.map((n: { name: string }) => n.name)).toEqual(["holder", "bound"]);
        expect(glb.json.animations[0].channels[0].target.node).toBe(1);
    });

    it("keeps a mesh child that a node-path channel animates as its own node", async () => {
        const holder = createTransformNode("holder");
        const a = attach(createMesh("a"), holder);
        const animated = attach(createMesh("animated"), holder);
        const glb = await exportGroups([group("g", [channel(animated, "translation")], [{ input: [0, 1], output: [0, 0, 0, 1, 1, 1] }])], { meshes: [a, animated] });
        expect(glb.json.nodes).toHaveLength(2);
        expect(glb.json.animations[0].channels[0].target.node).toBe(1);
    });
});
