/**
 * Portal visuals for the platformer demo: a procedural Mario-style warp **pipe**,
 * a dark **cave** backdrop, and the WGSL for a fullscreen **iris** wipe used as the
 * area-to-area transition.
 *
 * All three are generated at runtime with an offscreen 2D canvas (no image files
 * to ship), mirroring the parallax band textures. The iris transition is a single
 * fullscreen `createSprite2DCustomShader` quad — the same per-layer custom-fragment
 * path the star effect uses, and a stepping stone toward a true fullscreen
 * post-process (e.g. a CRT pass) later.
 */

function makeCtx(w: number, h: number): CanvasRenderingContext2D {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d", { alpha: true })!;
    return ctx;
}

/**
 * A classic green warp pipe as a square texture (drawn as a 2×2-tile sprite):
 * a wide lip/rim on top of a narrower shaft, with a highlight stripe, a shaded
 * right edge, and a dark opening. Straight alpha; transparent outside the pipe.
 */
export function makePipeTextureDataUrl(size = 128): string {
    const ctx = makeCtx(size, size);
    const s = size;
    const rimH = s * 0.3;
    const rimInset = s * 0.04;
    const shaftInset = s * 0.13;

    const fillRect = (x: number, y: number, w: number, h: number, color: string): void => {
        ctx.fillStyle = color;
        ctx.fillRect(x, y, w, h);
    };

    // Shaft (lower body).
    fillRect(shaftInset, rimH * 0.7, s - shaftInset * 2, s - rimH * 0.7, "#3aa636");
    // Shaft highlight + right-edge shade.
    fillRect(shaftInset + s * 0.05, rimH * 0.7, s * 0.12, s - rimH * 0.7, "#7fe06a");
    fillRect(s - shaftInset - s * 0.16, rimH * 0.7, s * 0.16, s - rimH * 0.7, "#2a7d28");
    // Shaft outline.
    ctx.lineWidth = Math.max(2, s * 0.02);
    ctx.strokeStyle = "#16531a";
    ctx.strokeRect(shaftInset, rimH * 0.7, s - shaftInset * 2, s - rimH * 0.7);

    // Rim/lip (wider, sits on top of the shaft).
    fillRect(rimInset, 0, s - rimInset * 2, rimH, "#46c83c");
    fillRect(rimInset + s * 0.06, 0, s * 0.12, rimH, "#86e873");
    fillRect(s - rimInset - s * 0.16, 0, s * 0.16, rimH, "#2f8f2c");
    ctx.strokeStyle = "#16531a";
    ctx.strokeRect(rimInset, 0, s - rimInset * 2, rimH);

    return ctx.canvas.toDataURL("image/png");
}

/** Tiny solid-white texture (the iris custom shader ignores the sampled colour). */
export function makeWhiteTextureDataUrl(size = 8): string {
    const ctx = makeCtx(size, size);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size, size);
    return ctx.canvas.toDataURL("image/png");
}

/**
 * Fullscreen iris-wipe fragment for `createSprite2DCustomShader`. Draws black
 * outside a centred circle whose radius is `fx.params.x` (in half-height units),
 * aspect-corrected by `fx.params.y`. A small feather softens the edge. The shader
 * ignores the atlas sample, so any tiny texture backs the layer.
 *
 *   fx.params.x = iris radius (≈1.35 fully open → 0 fully closed)
 *   fx.params.y = canvas aspect (width / height)
 */
export const IRIS_FRAGMENT = `
let p = (in.uv - vec2<f32>(0.5, 0.5)) * vec2<f32>(fx.params.y, 1.0);
let d = length(p);
let a = smoothstep(fx.params.x - 0.012, fx.params.x + 0.012, d);
return vec4<f32>(0.0, 0.0, 0.0, a);
`;
