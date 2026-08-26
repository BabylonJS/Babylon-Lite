// Stroke geometry — expand a flattened polyline into stroke triangles (a thick line).
//
// Each segment becomes a quad offset ±halfWidth perpendicular to the segment direction.
// Round joins/caps are added as small triangle fans at vertices; butt caps omit the endpoint fans.
// This keeps the outline gap-free at corners regardless of turn direction. The fill renderer stencils the UNION of
// these triangles (winding-independent increment-clamp) and covers once, so a semi-transparent
// stroke paints at a single uniform alpha instead of accumulating where the triangles overlap.

/** Triangle-fan segment count for round joins/caps. */
const JOIN_SEGMENTS = 6;

/**
 * Append stroke triangles (x,y pairs, 3 verts per triangle) to `out`.
 * `poly` holds `count` screen-space points (x,y interleaved). `halfWidth` is in screen px.
 * `closed` adds the wrap-around segment and treats every vertex as a join.
 * `cap === 1` omits round endpoint fans on open paths; other cap values retain the round fallback.
 * Returns the number of vertices appended.
 */
export function buildStrokePoints(poly: number[], count: number, halfWidth: number, closed: boolean, out: number[], cap = 2): number {
    if (count < 2 || halfWidth <= 0) {
        return 0;
    }
    const start = out.length;
    const segs = closed ? count : count - 1;
    let firstSegment = count;
    let lastSegmentEnd = 0;

    // Segment quads.
    for (let i = 0; i < segs; i++) {
        const i1 = (i + 1) % count;
        const ax = poly[i * 2];
        const ay = poly[i * 2 + 1];
        const bx = poly[i1 * 2];
        const by = poly[i1 * 2 + 1];
        let dx = bx - ax;
        let dy = by - ay;
        const len = Math.hypot(dx, dy);
        if (len < 1e-6) {
            continue;
        }
        firstSegment = Math.min(firstSegment, i);
        lastSegmentEnd = i1;
        dx /= len;
        dy /= len;
        // Perpendicular, scaled to half width.
        const nx = -dy * halfWidth;
        const ny = dx * halfWidth;
        const p0x = ax + nx;
        const p0y = ay + ny;
        const p1x = bx + nx;
        const p1y = by + ny;
        const p2x = bx - nx;
        const p2y = by - ny;
        const p3x = ax - nx;
        const p3y = ay - ny;
        out.push(p0x, p0y, p1x, p1y, p2x, p2y, p0x, p0y, p2x, p2y, p3x, p3y);
    }

    // Round joins at interior/closed vertices and round caps at open endpoints unless cap=butt.
    for (let i = 0; i < count; i++) {
        if (!closed && cap === 1 && (i <= firstSegment || i >= lastSegmentEnd)) {
            continue;
        }
        const cx = poly[i * 2];
        const cy = poly[i * 2 + 1];
        for (let k = 0; k < JOIN_SEGMENTS; k++) {
            const a0 = (k / JOIN_SEGMENTS) * Math.PI * 2;
            const a1 = ((k + 1) / JOIN_SEGMENTS) * Math.PI * 2;
            out.push(cx, cy, cx + Math.cos(a0) * halfWidth, cy + Math.sin(a0) * halfWidth, cx + Math.cos(a1) * halfWidth, cy + Math.sin(a1) * halfWidth);
        }
    }

    return (out.length - start) / 2;
}
