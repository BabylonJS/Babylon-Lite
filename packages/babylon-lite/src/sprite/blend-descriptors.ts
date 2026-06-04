/**
 * @internal Shared `GPUBlendState` literals reused by the sprite and billboard blend
 * descriptors. Kept as separate top-level `const` bindings (pure object literals, zero
 * side effects) so a surface that only imports one descriptor pays for only the blend
 * state(s) it actually references — and the alpha/premultiplied states are defined once
 * instead of being duplicated between the sprite and billboard modules.
 */

/** Straight-alpha over: color `{src-alpha, one-minus-src-alpha}`, alpha `{one, one-minus-src-alpha}`. */
export const _ALPHA_BLEND_STATE: GPUBlendState = {
    color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
    alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
};

/** Premultiplied over: color `{one, one-minus-src-alpha}`, alpha `{one, one-minus-src-alpha}`. */
export const _PREMULTIPLIED_BLEND_STATE: GPUBlendState = {
    color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
    alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
};
