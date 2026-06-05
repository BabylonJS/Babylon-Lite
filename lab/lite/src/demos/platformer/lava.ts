/**
 * Procedural molten-lava visuals for the platformer's underground (improvements #7 +
 * the per-layer slice of #9).
 *
 * A lava pool is a single `Sprite2DLayer` quad per channel, drawn with a custom
 * fragment that generates flowing, glowing magma entirely from `fx.time` + `in.uv`
 * (no texture sampling — it reuses the demo's 1×1 white atlas, the same trick the
 * freeciv GPU-water effect uses). The molten surface also **wobbles** its sample
 * coordinates with a scrolling sine, which is the per-layer "heat-haze" wobble from
 * idea #9 applied to the lava itself (a true fullscreen heat-haze that distorts the
 * whole frame would need the engine's offscreen-RT hook — out of scope here).
 *
 * Per-sprite sizing is uniform across pools of different widths by encoding the
 * pool's tile span in the sprite `color`: the fragment reads `in.tint.x` as the
 * width in tiles and scales `u` by it, so the magma cells are the same size in a
 * 9-tile channel as in a 4-tile one. `in.tint` is therefore NOT a colour here.
 */

/**
 * WGSL fragment body for the lava layer. In scope: `in.uv` (0..1 across the quad),
 * `in.tint` (repurposed: `.x` = pool width in tiles), `fx.time` (seconds, auto-
 * accumulating), and `L.opacityMul`. Fully procedural — no `atlasTex` sample.
 */
export const LAVA_FRAGMENT = `
let t = fx.time;
let tilesX = max(in.tint.x, 1.0);
let u = in.uv.x * tilesX;
let v = in.uv.y;                       // 0 at the molten surface (top), 1 at the bottom
// Heat-haze wobble of the sample coordinates (the per-layer #9 wobble on the lava).
let wob = sin(u * 3.1 + t * 2.0) * 0.05 + sin(u * 7.3 - t * 1.3) * 0.025;
let uu = u + t * 0.35;                 // slow molten horizontal flow
let vv = clamp(v + wob, 0.0, 1.0);
// Flowing magma field as layered sines (cheap pseudo-noise; no helper fns in a body).
let n = 0.5
    + 0.30 * sin(uu * 2.3 + vv * 3.7 + t * 1.1)
    + 0.20 * sin(uu * 5.1 - vv * 2.3 - t * 1.7)
    + 0.12 * sin(uu * 9.7 + vv * 6.1 + t * 0.7);
let hot = clamp(n - vv * 0.85 + 0.45, 0.0, 1.0);
let deepCol = vec3<f32>(0.42, 0.05, 0.02);
let midCol  = vec3<f32>(0.92, 0.28, 0.04);
let hotCol  = vec3<f32>(1.0, 0.78, 0.26);
var rgb = mix(deepCol, midCol, smoothstep(0.25, 0.6, hot));
rgb = mix(rgb, hotCol, smoothstep(0.62, 0.95, hot));
// Bright, shimmering crest along the very top edge of the pool.
let crest = smoothstep(0.18, 0.0, vv);
rgb = rgb + vec3<f32>(0.55, 0.36, 0.10) * crest * (0.7 + 0.3 * sin(t * 5.0 + u * 6.0));
// Slow whole-pool emissive pulse.
rgb = rgb * (0.92 + 0.10 * sin(t * 2.2 + u * 1.3));
return vec4<f32>(rgb, 1.0) * L.opacityMul;
`;
