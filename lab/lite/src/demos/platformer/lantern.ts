/**
 * Underground "lantern" lighting for the platformer (improvements #8).
 *
 * Two cheap, engine-free pieces layered over the cave:
 *  - A full-screen **multiply**-blended darkness quad whose fragment carves a soft
 *    radial pool of light around the player (the lantern). `fx.params` carries the
 *    player's normalised screen position + the light radius + the ambient floor;
 *    the sprite `color.x` carries the screen aspect so the pool stays circular.
 *  - Small **additive** warm glows (this module's radial texture) pinned to the wall
 *    torches, so each torch reads as a flickering point of light in the gloom.
 *
 * No engine work: a moving 2D light is just a multiply gradient, and the torch
 * glows are additive sprites — the same toolbox the freeciv day/night + city-glow
 * effects use.
 */

/**
 * WGSL fragment for the multiply darkness layer. In scope: `in.uv` (0..1 across the
 * screen), `in.tint` (`.x` = screen aspect `cw/ch`), `fx.params` = `[playerX, playerY,
 * radius, ambient]` (player position normalised 0..1, radius in screen-height units,
 * ambient = brightness far from the light). Drawn with `spriteBlendMultiply`.
 */
export const LANTERN_FRAGMENT = `
let p = fx.params.xy;
let radius = max(fx.params.z, 0.001);
let ambient = fx.params.w;
let aspect = max(in.tint.x, 0.01);
let dx = (in.uv.x - p.x) * aspect;
let dy = in.uv.y - p.y;
let d = sqrt(dx * dx + dy * dy);
// 1 inside the bright core, easing to 0 past the radius.
let lit = smoothstep(radius, radius * 0.32, d);
let bright = mix(ambient, 1.0, lit);
// Warm light at the core, cool shadow at the fringe.
let warm = mix(vec3<f32>(0.74, 0.80, 1.05), vec3<f32>(1.0, 0.92, 0.74), lit);
return vec4<f32>(warm * bright, 1.0);
`;

function makeCtx(w: number, h: number): CanvasRenderingContext2D {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c.getContext("2d", { alpha: true })!;
}

/** A soft white radial glow (transparent at the rim) for additive torch lights. */
export function makeGlowDataUrl(size = 96): string {
    const ctx = makeCtx(size, size);
    const r = size / 2;
    const g = ctx.createRadialGradient(r, r, 0, r, r, r);
    g.addColorStop(0.0, "rgba(255,255,255,1)");
    g.addColorStop(0.35, "rgba(255,255,255,0.5)");
    g.addColorStop(0.7, "rgba(255,255,255,0.16)");
    g.addColorStop(1.0, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    return ctx.canvas.toDataURL("image/png");
}
