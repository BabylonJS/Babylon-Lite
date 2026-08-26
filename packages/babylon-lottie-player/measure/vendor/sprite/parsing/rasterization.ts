import { type IVector2Like } from "../babylonTypes";

import { DecomposeWorldMatrixAtFrame, type AnimationNode } from "../nodes/node";
import { type RawLottieLayer, type RawVectorKeyframe } from "./rawTypes";

/**
 * Determines the frame at which a layer first becomes visible, used to choose the rasterization scale.
 * Shapes and text are rasterized once at this frame so the atlas resolution matches the layer's
 * on-screen size when it first appears.
 * @param layer The raw lottie layer being parsed.
 * @param startFrame The animation's start frame, used as a fallback when no opacity animation exists.
 * @returns The frame to rasterize the layer at.
 */
export function GetRasterizationFrame(layer: RawLottieLayer, startFrame: number): number {
    const fallback = layer.ip ?? startFrame;

    const opacityProp = layer.ks?.o;
    if (!opacityProp || opacityProp.a === 0) {
        return fallback;
    }

    const keyframes = opacityProp.k as RawVectorKeyframe[];
    if (keyframes.length === 0) {
        return fallback;
    }

    // If the first keyframe is already non-zero, the layer is visible from its start.
    if (keyframes[0].s[0] > 0) {
        return Math.max(fallback, keyframes[0].t);
    }

    // Otherwise find the first segment where opacity transitions from 0 to > 0.
    // For held segments (h === 1) the jump happens at the next keyframe's time.
    // For interpolated segments the layer becomes visible just after the current keyframe's time
    // (use t + 1 since lottie frame times are integers in practice).
    for (let i = 0; i < keyframes.length - 1; i++) {
        if (keyframes[i].s[0] === 0 && keyframes[i + 1].s[0] > 0) {
            const visibleFrame = keyframes[i].h === 1 ? keyframes[i + 1].t : keyframes[i].t + 1;
            return Math.max(fallback, visibleFrame);
        }
    }

    // Opacity never transitions to a visible value; fall back to the layer start.
    return fallback;
}

/**
 * Computes the world-space scale of a layer's parent at a specific frame, used to size rasterized sprites.
 * @param parent The parent node whose world scale drives the rasterization resolution.
 * @param rasterizationFrame The frame to evaluate the world matrix at.
 * @returns The world-space scale at the given frame.
 */
export function GetRasterizationScale(parent: AnimationNode, rasterizationFrame: number): IVector2Like {
    const scale = { x: 1, y: 1 };
    const tempPosition = { x: 0, y: 0 };

    // Always evaluate via DecomposeWorldMatrixAtFrame. The cached parent.worldMatrix reflects each
    // ancestor's transform at its own first keyframe time, which is not guaranteed to equal
    // rasterizationFrame (or even startFrame) — composition ip and per-layer keyframe start times
    // can all differ. DecomposeWorldMatrixAtFrame handles frames before/at/after keyframes uniformly.
    DecomposeWorldMatrixAtFrame(parent, rasterizationFrame, scale, tempPosition);

    return scale;
}
