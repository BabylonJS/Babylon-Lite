/** Animation export: one glTF animation per glTF-clip animation group. */

import type { AnimationGroup } from "../animation/animation-group.js";
import { INTERP_CUBICSPLINE, INTERP_STEP, PATH_POINTER, PATH_ROTATION, PATH_SCALE, PATH_TRANSLATION, PATH_WEIGHTS } from "../animation/types.js";
import type { AnimationSampler } from "../animation/types.js";
import { computeMinMax, FLOAT } from "./export-buffers.js";
import type { ExportContext } from "./export-context.js";
import { cachedAccessor } from "./export-context.js";
import { isExportableNode } from "./export-nodes.js";
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

/** @internal The scene nodes bound by a glTF-clip node channel (translation, rotation, scale or
 *  weights) — exactly the channels {@link exportAnimations} considers. They must export TRS, never
 *  `matrix`, and they seed root collection. */
export function collectAnimatedNodes(groups: readonly AnimationGroup[]): Set<object> {
    const out = new Set<object>();
    for (const group of groups) {
        const clip = group._gltfMixer?.[0];
        if (!clip) {
            continue;
        }
        for (let i = 0; i < clip.channels.length; i++) {
            const target = group.targetedAnimations[i]?.target;
            if (pathNameOf(clip.channels[i]!.path) !== undefined && isExportableNode(target)) {
                out.add(target);
            }
        }
    }
    return out;
}

/** The output array as exported: a converting target's translations get X negated and rotations the
 *  map (x, −y, −z, w) (a copy; values and CUBICSPLINE tangents alike). Non-spline rotation keys that
 *  are not unit length are renormalized, as glTF requires; otherwise pass-through output is the
 *  source array itself. */
function exportedOutput(output: Float32Array, pathName: AnimPathName, convert: boolean, cubic: boolean): Float32Array {
    let out: Float32Array | null = null;
    if (convert && pathName === "translation") {
        out = output.slice();
        for (let i = 0; i + 2 < out.length; i += 3) {
            out[i] = -out[i]!;
        }
    } else if (convert && pathName === "rotation") {
        out = output.slice();
        for (let i = 0; i + 3 < out.length; i += 4) {
            out[i + 1] = -out[i + 1]!;
            out[i + 2] = -out[i + 2]!;
        }
    }
    if (pathName === "rotation" && !cubic) {
        const src = out ?? output;
        for (let i = 0; i + 3 < src.length; i += 4) {
            const len = Math.hypot(src[i]!, src[i + 1]!, src[i + 2]!, src[i + 3]!);
            if (len > 0 && Math.abs(len - 1) > 0.0005) {
                out ??= output.slice();
                for (let c = 0; c < 4; c++) {
                    out[i + c] = src[i + c]! / len;
                }
            }
        }
    }
    return out ?? output;
}

function inputAccessor(ctx: ExportContext, input: Float32Array): number {
    return cachedAccessor(ctx, input, "animation-input", () => {
        const { min, max } = computeMinMax(input, 1);
        const bufferView = ctx.buffers.addBufferView(input);
        return ctx.buffers.addAccessor({ bufferView, componentType: FLOAT, count: input.length, type: "SCALAR", min, max });
    });
}

function componentsOf(pathName: AnimPathName): number {
    return pathName === "rotation" ? 4 : pathName === "weights" ? 1 : 3;
}

function outputAccessor(ctx: ExportContext, output: Float32Array, pathName: AnimPathName, convert: boolean, cubic: boolean): number {
    return cachedAccessor(ctx, output, `animation-${pathName}-${convert ? "c" : "p"}`, () => {
        const components = componentsOf(pathName);
        const type: GltfAccessorType = components === 4 ? "VEC4" : components === 1 ? "SCALAR" : "VEC3";
        const bufferView = ctx.buffers.addBufferView(exportedOutput(output, pathName, convert, cubic));
        return ctx.buffers.addAccessor({ bufferView, componentType: FLOAT, count: output.length / components, type });
    });
}

/** The number of morph targets of the glTF mesh on `node` (0 when it has none). */
function morphTargetCount(ctx: ExportContext, node: number): number {
    const meshIdx = ctx.doc.nodes[node]?.mesh;
    return meshIdx === undefined ? 0 : (ctx.doc.meshes[meshIdx]?.primitives[0]?.targets?.length ?? 0);
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
            const targetCount = pathName === "weights" ? morphTargetCount(ctx, node) : 1;
            if (targetCount === 0) {
                ctx.warn(`Animation "${group.name}" animates morph weights on a node without morph targets; skipping channel.`);
                continue;
            }
            // glTF needs at least one key and exactly (keys × values per key × 3 for splines) outputs.
            const cubic = clipSampler.interpolation === INTERP_CUBICSPLINE;
            const keys = clipSampler.input.length;
            if (keys === 0 || clipSampler.output.length !== keys * componentsOf(pathName) * targetCount * (cubic ? 3 : 1)) {
                ctx.warn(`Animation "${group.name}" has a sampler whose key and value counts do not match; skipping channel.`);
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
                    output: outputAccessor(ctx, clipSampler.output, pathName, convert, cubic),
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
