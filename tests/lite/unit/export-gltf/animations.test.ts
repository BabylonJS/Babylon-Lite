import { describe, expect, it } from "vitest";
import { attach, createMesh, createScene, expectClose, exportAndParse, loaderRoot, readAccessor } from "./export-test-utils";
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

type AnimationGroup = SceneContext["animationGroups"][number];
type Path = "translation" | "rotation" | "scale" | "weights" | "pointer";
interface Channel {
    target: object;
    path: Path;
    samplerIdx?: number;
    boundPath?: string;
}
interface Sampler {
    input: number[];
    output: number[];
    interpolation?: number;
}

function group(name: string, channels: Channel[], samplers: Sampler[]): AnimationGroup {
    const paths = { translation: PATH_TRANSLATION, rotation: PATH_ROTATION, scale: PATH_SCALE, weights: PATH_WEIGHTS, pointer: PATH_POINTER };
    const clip = {
        name,
        channels: channels.map((channel, index) => ({ samplerIdx: channel.samplerIdx ?? index, nodeIdx: index, path: paths[channel.path] })),
        samplers: samplers.map((sampler) => ({
            input: new Float32Array(sampler.input),
            output: new Float32Array(sampler.output),
            interpolation: sampler.interpolation ?? INTERP_LINEAR,
        })),
        duration: 1,
    };
    return {
        name,
        targetedAnimations: channels.map(({ target, path, boundPath }) => ({ target, path: boundPath ?? path })),
        _gltfMixer: [clip, [], []],
    } as unknown as AnimationGroup;
}

function morphMesh() {
    const targets = [0, 1].map(() => ({ positions: new Float32Array(12), normals: null }));
    return createMesh("m", { extra: { morphTargets: { targets, weights: new Float32Array([0, 0]), count: 2 } } });
}

describe("animations", () => {
    describe.each([false, true])("sampler values (pass-through: %s)", (passThrough) => {
        it.each<{ name: string; path: Path; interpolation: number; output: number[]; converted: number[]; normalized?: number[] }>([
            { name: "translation", path: "translation", interpolation: INTERP_LINEAR, output: [1, 2, 3], converted: [-1, 2, 3] },
            {
                name: "translation spline tangents",
                path: "translation",
                interpolation: INTERP_CUBICSPLINE,
                output: [1, 2, 3, 4, 5, 6, 7, 8, 9],
                converted: [-1, 2, 3, -4, 5, 6, -7, 8, 9],
            },
            { name: "LINEAR rotation", path: "rotation", interpolation: INTERP_LINEAR, output: [0, 0, 3, 4], normalized: [0, 0, 0.6, 0.8], converted: [0, 0, -0.6, 0.8] },
            { name: "STEP rotation", path: "rotation", interpolation: INTERP_STEP, output: [0, 3, 0, 4], normalized: [0, 0.6, 0, 0.8], converted: [0, -0.6, 0, 0.8] },
            { name: "near-unit rotation", path: "rotation", interpolation: INTERP_LINEAR, output: [0, 0, 0, 1.0004], converted: [0, 0, 0, 1.0004] },
            {
                name: "rotation spline tangents",
                path: "rotation",
                interpolation: INTERP_CUBICSPLINE,
                output: [1, 2, 3, 4, 2, 0, 0, 0, 5, 6, 7, 8],
                converted: [1, -2, -3, 4, 2, 0, 0, 0, 5, -6, -7, 8],
            },
        ])("preserves $name, normalizing only non-spline rotation keys", async ({ path, interpolation, output, converted, normalized }) => {
            const target = createTransformNode("target");
            if (passThrough) {
                attach(target, loaderRoot());
            }
            const animationGroups = [group("move", [{ target, path }], [{ input: [0], output, interpolation }])];
            const glb = await exportAndParse(createScene({ animationGroups }));
            const sampler = glb.json.animations[0].samplers[0];
            const expected = passThrough ? (normalized ?? output) : converted;
            expectClose(readAccessor(glb, sampler.output), expected);
            if (passThrough && !normalized) {
                expect(readAccessor(glb, sampler.output)).toEqual(Array.from(new Float32Array(output)));
            }
            expect(sampler.interpolation).toBe(interpolation === INTERP_LINEAR ? undefined : interpolation === INTERP_STEP ? "STEP" : "CUBICSPLINE");
        });
    });

    it.each<{ name: string; path: Path; input: number[]; output: number[]; interpolation?: number }>([
        { name: "empty", path: "translation", input: [], output: [] },
        { name: "translation", path: "translation", input: [0, 1], output: [0, 0, 0, 1, 1] },
        { name: "rotation", path: "rotation", input: [0, 1], output: [0, 0, 0, 1, 0, 0, 0] },
        { name: "spline", path: "translation", input: [0, 1], output: [0, 0, 0, 1, 1, 1], interpolation: INTERP_CUBICSPLINE },
        { name: "weights", path: "weights", input: [0, 1], output: [0, 1] },
    ])("rejects malformed $name sampler counts but keeps valid channels", async ({ path, input, output, interpolation }) => {
        const target = morphMesh();
        const other = createTransformNode("other");
        const animationGroups = [
            group(
                "g",
                [
                    { target, path },
                    { target: other, path: "scale" },
                ],
                [
                    { input, output, interpolation },
                    { input: [0, 1], output: [1, 1, 1, 2, 2, 2] },
                ]
            ),
        ];
        const glb = await exportAndParse(createScene({ meshes: [target], animationGroups }));
        expect(glb.warnings).toEqual(['Animation "g" has a sampler whose key and value counts do not match; skipping channel.']);
        expect(glb.json.animations[0].channels).toEqual([{ sampler: 0, target: { node: 1, path: "scale" } }]);
        expect(readAccessor(glb, glb.json.animations[0].samplers[0].output)).toEqual([1, 1, 1, 2, 2, 2]);
    });

    it("exports one scalar weight per key and target without handedness conversion", async () => {
        const mesh = morphMesh();
        const animationGroups = [group("weights", [{ target: mesh, path: "weights" }], [{ input: [0, 1], output: [0.25, 0.5, 0.75, 1] }])];
        const glb = await exportAndParse(createScene({ meshes: [mesh], animationGroups }));
        const sampler = glb.json.animations[0].samplers[0];
        expect(glb.json.accessors[sampler.output]).toMatchObject({ type: "SCALAR", count: 4 });
        expect(readAccessor(glb, sampler.output)).toEqual([0.25, 0.5, 0.75, 1]);
    });

    it("skips unsupported, duplicate and unbound channels while sharing surviving samplers", async () => {
        const a = createTransformNode("a");
        const b = createTransformNode("b");
        const channels: Channel[] = [
            { target: a, path: "translation" },
            { target: a, path: "translation" },
            { target: b, path: "translation" },
            { target: a, path: "pointer" },
            { target: { name: "foreign" }, path: "translation" },
            { target: a, path: "weights" },
        ];
        const samplers = [{ input: [0, 1], output: [0, 0, 0, 1, 1, 1] }];
        const animationGroups = [
            group(
                "kept",
                channels.map((channel) => ({ ...channel, samplerIdx: 0 })),
                samplers
            ),
            group("empty", [{ target: a, path: "pointer" }], samplers),
            { name: "native", targetedAnimations: [] } as unknown as AnimationGroup,
        ];
        const glb = await exportAndParse(createScene({ animationGroups }));
        expect(glb.json.animations.map((animation: { name: string }) => animation.name)).toEqual(["kept"]);
        expect(glb.json.animations[0].samplers).toHaveLength(1);
        expect(glb.json.animations[0].channels).toEqual([
            { sampler: 0, target: { node: 0, path: "translation" } },
            { sampler: 0, target: { node: 1, path: "translation" } },
        ]);
        for (const fragment of ["more than once", "KHR_animation_pointer", "not in the exported scene", "without morph targets", "no glTF-clip data"]) {
            expect(glb.warnings.some((warning) => warning.includes(fragment))).toBe(true);
        }
    });

    it("never folds a mesh bound by a numeric clip path, even if its string binding disagrees", async () => {
        const holder = createTransformNode("holder");
        const a = attach(createMesh("a"), holder);
        const bound = attach(createMesh("bound"), holder);
        const animationGroups = [group("move", [{ target: bound, path: "translation", boundPath: "visibility" }], [{ input: [0, 1], output: [0, 0, 0, 1, 1, 1] }])];
        const glb = await exportAndParse(createScene({ meshes: [a, bound], animationGroups }));
        expect(glb.json.nodes.map((node: { name: string }) => node.name)).toEqual(["holder", "bound"]);
        expect(glb.json.meshes[0].primitives).toHaveLength(1);
        expect(glb.json.animations[0].channels[0].target).toEqual({ node: 1, path: "translation" });
    });
});
