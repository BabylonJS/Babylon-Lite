/**
 * Sprite blend modes as importable, pure-data descriptor values.
 *
 * Each blend mode is its own top-level `const` binding, so a scene ships only the
 * descriptor(s) it imports — a default (alpha) scene references `spriteBlendAlpha` and
 * nothing else; importing `spriteBlendAdditive` does NOT drag in `spriteBlendPremultiplied`.
 * The sprite pipeline reads `_descriptor` / `_key` / `_premultipliedOpacity` directly off
 * the value, so there is no runtime string lookup table for the bundler to retain.
 */
import { _ALPHA_BLEND_STATE, _PREMULTIPLIED_BLEND_STATE } from "./blend-descriptors.js";

/**
 * A sprite-layer blend descriptor. Pass one of the exported `spriteBlend*` values to
 * `createSprite2DLayer({ blendMode })`. The fields are internal plumbing; treat the value
 * as opaque.
 */
export interface SpriteBlendDescriptor {
    /** @internal Pipeline-cache discriminator (distinguishes blend variants of one pipeline). */
    readonly _key: string;
    /** @internal Color-target blend state; `undefined` means no color blend (opaque). */
    readonly _descriptor?: GPUBlendState;
    /** @internal When true, per-layer opacity scales RGB *and* A (premultiplied fade). */
    readonly _premultipliedOpacity?: boolean;
}

/**
 * Straight-alpha "over" blending (the default). RGB is composited by source alpha; this is
 * the standard transparency mode for HUDs, UI, and soft-edged sprites.
 */
export const spriteBlendAlpha: SpriteBlendDescriptor = {
    _key: "alpha",
    _descriptor: _ALPHA_BLEND_STATE,
};

/**
 * Premultiplied-alpha "over" blending. The sprite's RGB is assumed already multiplied by its
 * alpha; per-layer opacity scales RGB and A together for a correct fade.
 */
export const spriteBlendPremultiplied: SpriteBlendDescriptor = {
    _key: "premultiplied",
    _descriptor: _PREMULTIPLIED_BLEND_STATE,
    _premultipliedOpacity: true,
};

/**
 * Additive blending. The sprite's RGB, scaled by its own alpha, is added to the framebuffer,
 * so glows / light shafts / sparks stack and brighten (stars, embers, fireflies, sun shafts).
 */
export const spriteBlendAdditive: SpriteBlendDescriptor = {
    _key: "additive",
    _descriptor: {
        color: { srcFactor: "src-alpha", dstFactor: "one", operation: "add" },
        alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
    },
};

/**
 * Multiply blending. The framebuffer is multiplied by the sprite's RGB (`result = src * dst`),
 * so the sprite darkens / tints what is behind it — ideal for soft shadow blobs, dirt / grime
 * decals, ambient-occlusion stamps, and coloured "gel" overlays that modulate the scene colour.
 * Sprites should be opaque (or white where they must leave the background unchanged) since a pure
 * multiply ignores source alpha for RGB.
 */
export const spriteBlendMultiply: SpriteBlendDescriptor = {
    _key: "multiply",
    _descriptor: {
        color: { srcFactor: "dst", dstFactor: "zero", operation: "add" },
        alpha: { srcFactor: "dst-alpha", dstFactor: "zero", operation: "add" },
    },
};
