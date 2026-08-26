// Text renderer — rasterizes each text layer to a texture via Canvas2D (OffscreenCanvas, so it runs
// unchanged inside a worker) and draws it as a textured quad. A thin adapter over the shared
// textured-quad renderer: it owns the per-block rasterization + upload; all GL plumbing lives in
// textured-quad.ts.
//
// Lottie text here has no baked glyph outlines, so we rely on the platform font (Segoe UI etc.) via
// Canvas2D `fillText`. Each text document is rasterized ONCE at a supersampled resolution; per frame
// its layer transform maps the text's local rect to a screen quad. Animated text (per-glyph
// animators) is not handled — the whole block draws at the layer opacity.

import { type GLEngineContext, type GLTexture, createDynamicTexture, disposeTexture, updateDynamicTexture } from "@babylonjs/lite-gl";
import type { LayerRenderer } from "./layer-renderer.js";
import type { ParsedLayer, ParsedText } from "../animation/parse.js";
import { createTexturedQuadRenderer, type QuadRect } from "./textured-quad.js";

const SUPERSAMPLE = 3; // rasterize at 3x for crisp downscaling

/** A rasterized text block: its texture and the layer-local rect the texture covers. */
interface TextBlock {
    texture: GLTexture;
    /** Local-space rect [left, top, width, height] (content units, origin at text anchor). */
    left: number;
    top: number;
    width: number;
    height: number;
}

function cssFont(t: ParsedText): string {
    return `${t.style} ${t.weight} ${t.size}px "${t.family}"`;
}

/** Greedy word-wrap a single paragraph to fit within `maxW` (in local px). */
function wrapParagraph(ctx: OffscreenCanvasRenderingContext2D, text: string, maxW: number): string[] {
    if (text.length === 0) {
        return [""];
    }
    const words = text.split(" ");
    const lines: string[] = [];
    let current = "";
    for (const word of words) {
        const test = current ? current + " " + word : word;
        if (current && ctx.measureText(test).width > maxW) {
            lines.push(current);
            current = word;
        } else {
            current = test;
        }
    }
    if (current) {
        lines.push(current);
    }
    return lines;
}

/** Rasterize one text document into an `OffscreenCanvas` + its local rect. The caller uploads the
 *  canvas to a GL texture. Returns null when the block has no area. Uses `OffscreenCanvas` so the
 *  text renderer works unchanged inside a worker (no DOM). */
function rasterizeText(t: ParsedText): { canvas: OffscreenCanvas; left: number; top: number; width: number; height: number } | null {
    const canvas = new OffscreenCanvas(1, 1);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
        return null;
    }
    const font = cssFont(t);
    ctx.font = font;
    // Letter spacing (Chrome 99+); harmless if unsupported.
    (ctx as unknown as { letterSpacing: string }).letterSpacing = `${t.letterSpacing}px`;

    // Build lines: explicit breaks always; boxed/paragraph text also word-wraps to the box width.
    const boxed = t.boxW !== undefined && t.boxW > 0;
    const rawLines = t.text.split(/\r\n|\r|\n/);
    let lines: string[];
    if (boxed) {
        lines = [];
        for (const rl of rawLines) {
            lines.push(...wrapParagraph(ctx, rl, t.boxW!));
        }
    } else {
        lines = rawLines;
    }

    // Measure.
    let maxW = 0;
    for (const line of lines) {
        maxW = Math.max(maxW, ctx.measureText(line).width);
    }
    const m = ctx.measureText("Mg");
    const ascent = m.fontBoundingBoxAscent || t.size * 0.8;
    const descent = m.fontBoundingBoxDescent || t.size * 0.25;
    const pad = Math.ceil(t.size * 0.35);
    const blockH = ascent + (lines.length - 1) * t.lineHeight + descent;
    // Content width: a boxed layer reserves the full box width so justification + the box
    // origin map exactly; point text uses the measured max line width.
    const contentW = boxed ? t.boxW! : maxW;
    const localW = contentW + 2 * pad;
    const localH = blockH + 2 * pad;
    if (localW < 1 || localH < 1) {
        return null;
    }

    canvas.width = Math.ceil(localW * SUPERSAMPLE);
    canvas.height = Math.ceil(localH * SUPERSAMPLE);
    // Re-apply state after resize (resizing clears the context).
    ctx.scale(SUPERSAMPLE, SUPERSAMPLE);
    ctx.font = font;
    (ctx as unknown as { letterSpacing: string }).letterSpacing = `${t.letterSpacing}px`;
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = `rgb(${Math.round(t.color[0] * 255)}, ${Math.round(t.color[1] * 255)}, ${Math.round(t.color[2] * 255)})`;

    for (let i = 0; i < lines.length; i++) {
        const lineW = ctx.measureText(lines[i]).width;
        let lineX = pad; // left
        if (t.justify === 2) {
            lineX = pad + (contentW - lineW) / 2;
        } else if (t.justify === 1) {
            lineX = pad + (contentW - lineW);
        }
        ctx.fillText(lines[i], lineX, pad + ascent + i * t.lineHeight);
    }

    // Local rect: where the texture maps in layer-local space.
    let localLeft: number;
    let localTop: number;
    if (boxed) {
        // Boxed text is anchored at its box top-left (`ps`); the first baseline sits one ascent
        // below the box top. The texture top-left is one `pad` up-left of the box origin.
        localLeft = (t.boxX ?? 0) - pad;
        localTop = (t.boxY ?? 0) - pad;
    } else {
        // Point text: the first-line baseline start sits at local (0,0); justify shifts the origin.
        if (t.justify === 2) {
            localLeft = -maxW / 2 - pad;
        } else if (t.justify === 1) {
            localLeft = -maxW - pad;
        } else {
            localLeft = -pad;
        }
        localTop = -(pad + ascent);
    }

    return { canvas, left: localLeft, top: localTop, width: localW, height: localH };
}

/** Create the text-layer renderer. Rasterizes every text document up front. */
export function createTextRenderer(engine: GLEngineContext, textLayers: readonly ParsedLayer[]): LayerRenderer {
    // Rasterize every text block up front, keyed by layer ind.
    const blocks = new Map<number, TextBlock>();
    for (const layer of textLayers) {
        if (!layer.text || layer.text.text.length === 0) {
            continue;
        }
        const r = rasterizeText(layer.text);
        if (!r) {
            continue;
        }
        // Upload the rasterized glyph bitmap via the dynamic-texture path: it accepts an
        // `OffscreenCanvas` as a `TexImageSource`, so the same upload works on the main thread and
        // in a worker. Straight alpha (no premultiply) — the fragment shader premultiplies.
        const texture = createDynamicTexture(engine, r.canvas.width, r.canvas.height);
        updateDynamicTexture(engine, texture, r.canvas, false, false);
        blocks.set(layer.ind, { texture, left: r.left, top: r.top, width: r.width, height: r.height });
    }

    return createTexturedQuadRenderer(engine, {
        kind: 5,
        fillRect(layer: ParsedLayer, rect: QuadRect): boolean {
            const block = blocks.get(layer.ind);
            if (!block) {
                return false;
            }
            rect.left = block.left;
            rect.top = block.top;
            rect.width = block.width;
            rect.height = block.height;
            return true;
        },
        textureFor: (layer) => blocks.get(layer.ind)?.texture ?? null,
        disposeTextures() {
            for (const block of blocks.values()) {
                disposeTexture(engine, block.texture);
            }
            blocks.clear();
        },
    });
}
