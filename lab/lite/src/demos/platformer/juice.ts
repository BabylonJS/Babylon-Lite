/**
 * "Juice" textures for the platformer demo (feature #6): a small sparkle used for
 * additive burst particles on coin-collect and enemy-stomp.
 *
 * Generated at runtime with an offscreen 2D canvas (no image files), like the
 * other procedural demo art. The spark is drawn pure **white** so per-sprite
 * `color` tint (gold for coins, white for stomps) colours it cleanly on the
 * additive layer, where the alpha ramp carries the glow intensity.
 */

/** A 4-point star sparkle: bright core + tapered rays, white on transparent. */
export function makeSparkDataUrl(size = 64): string {
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    const ctx = c.getContext("2d", { alpha: true })!;
    const cx = size / 2;

    // Soft round core.
    const core = ctx.createRadialGradient(cx, cx, 0, cx, cx, size * 0.22);
    core.addColorStop(0, "rgba(255,255,255,1)");
    core.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = core;
    ctx.fillRect(0, 0, size, size);

    // Four tapered rays (N/E/S/W) as thin diamonds fading outward.
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    const ray = (angle: number): void => {
        ctx.save();
        ctx.translate(cx, cx);
        ctx.rotate(angle);
        const len = size * 0.48;
        const half = size * 0.06;
        const g = ctx.createLinearGradient(0, 0, len, 0);
        g.addColorStop(0, "rgba(255,255,255,0.95)");
        g.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(0, -half);
        ctx.lineTo(len, 0);
        ctx.lineTo(0, half);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    };
    for (let i = 0; i < 4; i++) ray((i * Math.PI) / 2);

    return c.toDataURL("image/png");
}
