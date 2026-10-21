/** Animation export: one glTF animation per glTF-clip animation group. */

import type { AnimationGroup } from "../animation/animation-group.js";
import { INTERP_CUBICSPLINE, INTERP_STEP, PATH_POINTER, PATH_ROTATION, PATH_SCALE, PATH_TRANSLATION, PATH_WEIGHTS } from "../animation/types.js";
import type { AnimationSampler } from "../animation/types.js";
import { computeMinMax } from "./export-buffers.js";
import type { ExportContext } from "./export-context.js";
import type { GltfAccessorType, GltfAnimation, GltfAnimationChannel, GltfAnimationSampler } from "./export-gltf-types.js";

type AnimPathName = "translation" | "rotation" | "scale" | "weights";

function pathNameOf(path: number): AnimPathName | undefined {
    switch (path) {
        case PATH_TRANSLATION:
            return "translation";
        case PATH_ROTATION:
            return "rotation";
        case PATH_SCALE:
            return "scale";
        case PATH_WEIGHTS:
            return "weights";
        default:
            return undefined;
    }
}

/** Left-handed → right-handed conversion of a translation/rotation output array (a copy). */
function convertOutput(output: Float32Array, pathName: AnimPathName): Float32Array {
    const out = output.slice();
    if (pathName === "translation") {
        for (let i = 0; i + 2 < out.length; i += 3) {
            out[i] = -out[i]!;
        }
    } else if (pathName === "rotation") {
        for (let i = 0; i + 3 < out.length; i += 4) {
            out[i + 1] = -out[i + 1]!;
            out[i + 2] = -out[i + 2]!;
        }
    }
    return out;
}

function cachedAccessor(ctx: ExportContext, source: Float32Array, variant: string, create: () => number): number {
    let byVariant = ctx.accessorIndex.get(source);
    const existing = byVariant?.get(variant);
    if (existing !== undefined) {
        return existing;
    }
    const index = create();
    if (!byVariant) {
        byVariant = new Map();
        ctx.accessorIndex.set(source, byVariant);
    }
    byVariant.set(variant, index);
    return index;
}

function inputAccessor(ctx: ExportContext, input: Float32Array): number {
    return cachedAccessor(ctx, input, "animation-input", () => {
        const { min, max } = computeMinMax(input, 1);
        const bufferView = ctx.buffers.addBufferView(input);
        return ctx.buffers.addAccessor({ bufferView, componentType: 5126, count: input.length, type: "SCALAR", min, max });
    });
}

function outputAccessor(ctx: ExportContext, output: Float32Array, pathName: AnimPathName, convert: boolean): number {
    return cachedAccessor(ctx, output, `animation-${pathName}-${convert ? "c" : "p"}`, () => {
        const components = pathName === "rotation" ? 4 : pathName === "weights" ? 1 : 3;
        const type: GltfAccessorType = components === 4 ? "VEC4" : components === 1 ? "SCALAR" : "VEC3";
        const data = convert ? convertOutput(output, pathName) : output;
        const bufferView = ctx.buffers.addBufferView(data);
        return ctx.buffers.addAccessor({ bufferView, componentType: 5126, count: output.length / components, type });
    });
}

function hasMorphTargets(ctx: ExportContext, node: number): boolean {
    const meshIdx = ctx.doc.nodes[node]?.mesh;
    if (meshIdx === undefined) {
        return false;
    }
    const targets = ctx.doc.meshes[meshIdx]?.primitives[0]?.targets;
    return targets !== undefined && targets.length > 0;
}

function interpolationOf(sampler: AnimationSampler): GltfAnimationSampler["interpolation"] {
    return sampler.interpolation === INTERP_STEP ? "STEP" : sampler.interpolation === INTERP_CUBICSPLINE ? "CUBICSPLINE" : undefined;
}

/** @internal Emit one glTF animation per glTF-clip animation group (synchronous, capture phase). */
export function exportAnimations(ctx: ExportContext, groups: readonly AnimationGroup[]): void {
    for (const group of groups) {
        if (!group._gltfMixer) {
            ctx.warn(`Animation group "${group.name}" has no glTF-clip data; skipping.`);
            continue;
        }
        const clip = group._gltfMixer[0];
        const channels: GltfAnimationChannel[] = [];
        const samplers: GltfAnimationSampler[] = [];
        const samplerIndex = new Map<string, number>();
        const used = new Set<string>();

        for (let i = 0; i < clip.channels.length; i++) {
            const channel = clip.channels[i]!;
            if (channel.path === PATH_POINTER) {
                ctx.warn(`KHR_animation_pointer channel in "${group.name}" is skipped on export.`);
                continue;
            }
            const target = group.targetedAnimations[i]?.target;
            const node = target === undefined ? undefined : ctx.nodeIndex.get(target);
            if (target === undefined || node === undefined) {
                ctx.warn(`Animation channel target (node ${channel.nodeIdx}) is not in the exported scene; skipping channel.`);
                continue;
            }
            const pathName = pathNameOf(channel.path);
            const clipSampler = clip.samplers[channel.samplerIdx];
            if (pathName === undefined || clipSampler === undefined) {
                continue;
            }
            if (pathName === "weights" && !hasMorphTargets(ctx, node)) {
                ctx.warn(`Animation "${group.name}" animates morph weights on a node without morph targets; skipping channel.`);
                continue;
            }
            const useKey = `${node}:${pathName}`;
            if (used.has(useKey)) {
                ctx.warn(`Animation "${group.name}" targets node ${node} ${pathName} more than once; keeping the first channel.`);
                continue;
            }
            used.add(useKey);

            const convert = ctx.nodeConvert.get(target) === true;
            const samplerKey = `${channel.samplerIdx}:${pathName}:${convert ? "c" : "p"}`;
            let sampler = samplerIndex.get(samplerKey);
            if (sampler === undefined) {
                const out: GltfAnimationSampler = {
                    input: inputAccessor(ctx, clipSampler.input),
                    output: outputAccessor(ctx, clipSampler.output, pathName, convert),
                };
                const interpolation = interpolationOf(clipSampler);
                if (interpolation) {
                    out.interpolation = interpolation;
                }
                sampler = samplers.push(out) - 1;
                samplerIndex.set(samplerKey, sampler);
            }
            channels.push({ sampler, target: { node, path: pathName } });
        }

        if (channels.length === 0) {
            continue;
        }
        const animation: GltfAnimation = { channels, samplers };
        if (group.name) {
            animation.name = group.name;
        }
        ctx.doc.animations.push(animation);
    }
}
