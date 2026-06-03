/**
 * Billboard blend modes as importable, pure-data descriptor values.
 *
 * Mirrors `sprite-blend.ts` for world-space billboards. Each mode is its own tree-shaken
 * `const`, so a scene pays only for the descriptor(s) it imports. `cutout` carries no color
 * blend (`_descriptor` undefined) and drives the alpha-test depth-write path via `_depthMode`.
 */
import type { BillboardDepthMode } from "./billboard-sprite.js";
import { _ALPHA_BLEND_STATE, _PREMULTIPLIED_BLEND_STATE } from "./blend-descriptors.js";

/**
 * A billboard-system blend descriptor. Pass one of the exported `billboardBlend*` values to
 * `createFacingBillboardSystem` / `createAxisLockedBillboardSystem` via `{ blendMode }`. The
 * fields are internal plumbing; treat the value as opaque.
 */
export interface BillboardBlendDescriptor {
    /** @internal Pipeline-cache discriminator. */
    readonly _key: string;
    /** @internal Color-target blend state; `undefined` for the alpha-tested cutout path. */
    readonly _descriptor?: GPUBlendState;
    /** @internal When true, per-system opacity scales RGB *and* A (premultiplied fade). */
    readonly _premultipliedOpacity?: boolean;
    /** @internal Depth/blend pipeline path this mode selects. */
    readonly _depthMode: BillboardDepthMode;
}

/** Straight-alpha "over" blending (the default) for transparent billboards. */
export const billboardBlendAlpha: BillboardBlendDescriptor = {
    _key: "alpha",
    _descriptor: _ALPHA_BLEND_STATE,
    _depthMode: "transparent",
};

/** Premultiplied-alpha "over" blending; per-system opacity scales RGB and A together. */
export const billboardBlendPremultiplied: BillboardBlendDescriptor = {
    _key: "premultiplied",
    _descriptor: _PREMULTIPLIED_BLEND_STATE,
    _premultipliedOpacity: true,
    _depthMode: "transparent",
};

/**
 * Alpha-test cutout: no color blend; fragments below `alphaCutoff` are discarded and surviving
 * fragments write depth, so cutout billboards occlude correctly like opaque geometry.
 */
export const billboardBlendCutout: BillboardBlendDescriptor = {
    _key: "cutout",
    _depthMode: "cutout",
};

/**
 * Additive blending for world-space billboards. The billboard's RGB, scaled by its own alpha, is
 * added to the framebuffer (no depth write, like the other transparent modes), so overlapping
 * billboards stack and brighten — world-space embers, sparks, muzzle flashes, and light shafts.
 */
export const billboardBlendAdditive: BillboardBlendDescriptor = {
    _key: "additive",
    _descriptor: {
        color: { srcFactor: "src-alpha", dstFactor: "one", operation: "add" },
        alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
    },
    _depthMode: "transparent",
};
