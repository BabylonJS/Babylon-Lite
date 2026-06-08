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
 * The top is a **bubbly, undulating surface silhouette** carved with alpha (the quad
 * is transparent above the wavy molten line), so the pool reads as organic lava
 * rather than a glowing rectangular slab; the deepest band settles toward a dark red
 * so it recedes into the rock instead of floating, and faint **embers** rise from below.
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
let v = in.uv.y;                          // 0 = top of quad, 1 = bottom

// ── Bubbly molten SURFACE silhouette near the top ───────────────────────────
// Undulating ripples plus slow rounded swells (forming bubbles), so the lava's top
// reads as organic/blobby rather than a straight glowing slab edge. Smaller v sits
// nearer the channel rim.
let ripple = 0.050 * sin(u * 2.7 + t * 1.3)
           + 0.030 * sin(u * 5.3 - t * 0.9)
           + 0.018 * sin(u * 11.0 + t * 2.1);
let swell = 0.07 * max(0.0, sin(u * 1.3 - t * 0.8) - 0.3);   // travelling bulges push the surface up
let surf = 0.13 + ripple - swell;

// Soft alpha cut at the wavy surface (transparent above it → no hard slab edge).
let aa = 0.012;
let surfMask = smoothstep(surf - aa, surf + aa, v);

// Depth BELOW the wavy surface: 0 at the molten top → 1 at the dark bottom.
let depth = clamp((v - surf) / (1.0 - surf), 0.0, 1.0);

// Heat-haze wobble of the flow coordinates (the per-layer #9 wobble on the lava).
let wob = sin(u * 3.1 + t * 2.0) * 0.05 + sin(u * 7.3 - t * 1.3) * 0.025;
let uu = u + t * 0.35;                    // slow molten horizontal flow
let dd = clamp(depth + wob, 0.0, 1.0);

// Flowing magma field as layered sines (cheap pseudo-noise; no helper fns in a body).
let n = 0.5
    + 0.30 * sin(uu * 2.3 + dd * 3.7 + t * 1.1)
    + 0.20 * sin(uu * 5.1 - dd * 2.3 - t * 1.7)
    + 0.12 * sin(uu * 9.7 + dd * 6.1 + t * 0.7);
let hot = clamp(n - dd * 0.95 + 0.5, 0.0, 1.0);
let deepCol = vec3<f32>(0.74, 0.14, 0.06);
let midCol  = vec3<f32>(0.92, 0.28, 0.04);
let hotCol  = vec3<f32>(1.0, 0.80, 0.30);
var rgb = mix(deepCol, midCol, smoothstep(0.22, 0.6, hot));
rgb = mix(rgb, hotCol, smoothstep(0.62, 0.95, hot));

// Shimmering crest hugging the bubbly surface.
let crest = smoothstep(0.12, 0.0, depth);
rgb = rgb + vec3<f32>(0.55, 0.36, 0.10) * crest * (0.7 + 0.3 * sin(t * 5.0 + u * 6.0));

// Rising embers from the depths: sparse bright motes drifting up and fading near the top.
let ex = u * 2.3;
let ey = depth * 3.0 + t * 0.6;           // as t grows, a mote's depth shrinks → it rises
let cellHash = fract(sin(floor(ex) * 127.1 + floor(ey) * 311.7) * 43758.5);
let px = fract(ex) - 0.5;
let py = fract(ey) - 0.5;
let mote = smoothstep(0.13, 0.0, sqrt(px * px + py * py)) * step(0.86, cellHash);
rgb = rgb + vec3<f32>(1.0, 0.6, 0.2) * mote * (0.35 + 0.5 * depth);

// Settle the deepest band toward a warm DARK RED (not black) so the pool reads as
// molten depth glowing in the rock, rather than a dark void at the bottom. Kept fairly
// bright + only a partial mix so the deep stays clearly red-hot.
let deepRed = vec3<f32>(0.92, 0.18, 0.07);
rgb = mix(rgb, deepRed, 0.9 * smoothstep(0.4, 1.0, depth));

// Slow whole-pool emissive pulse.
rgb = rgb * (0.92 + 0.10 * sin(t * 2.2 + u * 1.3));

return vec4<f32>(rgb, surfMask) * L.opacityMul;
`;
