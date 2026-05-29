/** Extract quadratic Bézier outlines from a font. Memoized per (font, glyphId). */

import { getGlyphPath } from "text-shaper";
import type { GlyphBounds, GlyphCurves, QuadCurve } from "./public-types.js";
import { getCurvesCacheForFont, type Font } from "./internal.js";
import { getRawFont } from "./font.js";

/** Approximate a cubic Bézier with two quadratics using the "3/4 rule" (matches Slug reference). */
function cubicToQuadratics(p0x: number, p0y: number, c1x: number, c1y: number, c2x: number, c2y: number, p1x: number, p1y: number): [QuadCurve, QuadCurve] {
    const q0cx = p0x + (c1x - p0x) * 0.75;
    const q0cy = p0y + (c1y - p0y) * 0.75;
    const q1cx = p1x + (c2x - p1x) * 0.75;
    const q1cy = p1y + (c2y - p1y) * 0.75;
    const midx = (q0cx + q1cx) * 0.5;
    const midy = (q0cy + q1cy) * 0.5;
    return [
        { p0x, p0y, p1x: q0cx, p1y: q0cy, p2x: midx, p2y: midy },
        { p0x: midx, p0y: midy, p1x: q1cx, p1y: q1cy, p2x: p1x, p2y: p1y },
    ];
}

function extractOne(font: Font, glyphId: number): GlyphCurves | null {
    const path = getGlyphPath(getRawFont(font), glyphId);
    if (!path || !path.bounds) {
        return null;
    }
    const curves: QuadCurve[] = [];
    let curX = 0;
    let curY = 0;
    let startX = 0;
    let startY = 0;
    for (const cmd of path.commands) {
        switch (cmd.type) {
            case "M":
                curX = cmd.x;
                curY = cmd.y;
                startX = cmd.x;
                startY = cmd.y;
                break;
            case "L": {
                const dx = cmd.x - curX;
                const dy = cmd.y - curY;
                if (Math.abs(dx) >= 0.1 || Math.abs(dy) >= 0.1) {
                    const mx = (curX + cmd.x) * 0.5;
                    const my = (curY + cmd.y) * 0.5;
                    curves.push({ p0x: curX, p0y: curY, p1x: mx, p1y: my, p2x: cmd.x, p2y: cmd.y });
                }
                curX = cmd.x;
                curY = cmd.y;
                break;
            }
            case "Q":
                curves.push({ p0x: curX, p0y: curY, p1x: cmd.x1, p1y: cmd.y1, p2x: cmd.x, p2y: cmd.y });
                curX = cmd.x;
                curY = cmd.y;
                break;
            case "C": {
                const [q1, q2] = cubicToQuadratics(curX, curY, cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y);
                curves.push(q1, q2);
                curX = cmd.x;
                curY = cmd.y;
                break;
            }
            case "Z": {
                const cdx = startX - curX;
                const cdy = startY - curY;
                if (Math.abs(cdx) > 0.1 || Math.abs(cdy) > 0.1) {
                    const mx = (curX + startX) * 0.5;
                    const my = (curY + startY) * 0.5;
                    curves.push({ p0x: curX, p0y: curY, p1x: mx, p1y: my, p2x: startX, p2y: startY });
                }
                curX = startX;
                curY = startY;
                break;
            }
        }
    }
    if (curves.length === 0) {
        return null;
    }
    const bounds: GlyphBounds = {
        xMin: path.bounds.xMin,
        yMin: path.bounds.yMin,
        xMax: path.bounds.xMax,
        yMax: path.bounds.yMax,
    };
    return { glyphId, curves, bounds };
}

/** Extract outlines for the requested glyph ids and add them to `target`.
 *  Skips ids already present in `target`. Glyphs with no outline are silently skipped.
 *  Mutates `target` directly — no allocation when no new glyphs appear. */
export function extractGlyphCurves(font: Font, glyphIds: ReadonlySet<number>, target: Map<number, GlyphCurves>): void {
    const cache = getCurvesCacheForFont(font);
    for (const id of glyphIds) {
        if (target.has(id)) {
            continue;
        }
        let entry = cache.get(id);
        if (entry === undefined) {
            const extracted = extractOne(font, id);
            if (extracted == null) {
                // Sentinel: cache the absence by skipping target; future calls re-skip via target.has.
                continue;
            }
            entry = extracted;
            cache.set(id, entry);
        }
        target.set(id, entry);
    }
}
