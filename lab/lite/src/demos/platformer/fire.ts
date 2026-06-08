/**
 * Procedural textures for the fire power-up (feature #4): a fire **flower** pickup
 * and a glowing **fireball** projectile. Both are generated at runtime with an
 * offscreen 2D canvas (no image files to ship), mirroring the parallax/portal art.
 *
 * The fireball is drawn on an **additive** sprite layer, so its texture is a soft
 * radial glow whose alpha carries the intensity (bright warm core → transparent
 * edge) — stacking fireballs brighten, the classic projectile look.
 */

function makeCtx(w: number, h: number): CanvasRenderingContext2D {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d", { alpha: true })!;
    return ctx;
}

/**
 * A fire flower: a ring of red/orange petals around a pale face on a green stem
 * with two leaves. Square texture, art roughly centred with light padding.
 */
export function makeFireFlowerDataUrl(size = 128): string {
    const ctx = makeCtx(size, size);
    const cx = size / 2;
    const headY = size * 0.36;
    const headR = size * 0.26;

    // Stem.
    ctx.strokeStyle = "#3aa14a";
    ctx.lineWidth = size * 0.07;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(cx, headY + headR * 0.7);
    ctx.lineTo(cx, size * 0.9);
    ctx.stroke();
    // Leaves.
    ctx.fillStyle = "#43c25a";
    for (const dir of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(cx + dir * size * 0.12, size * 0.72, size * 0.12, size * 0.06, (dir * Math.PI) / 5, 0, Math.PI * 2);
        ctx.fill();
    }

    // Petals — eight rounded lobes alternating red / orange.
    const petals = 8;
    for (let i = 0; i < petals; i++) {
        const a = (i / petals) * Math.PI * 2;
        const px = cx + Math.cos(a) * headR * 0.92;
        const py = headY + Math.sin(a) * headR * 0.92;
        ctx.fillStyle = i % 2 === 0 ? "#ff3b2e" : "#ff8a1e";
        ctx.beginPath();
        ctx.arc(px, py, headR * 0.42, 0, Math.PI * 2);
        ctx.fill();
    }
    // Pale face + dark center.
    ctx.fillStyle = "#ffe9b0";
    ctx.beginPath();
    ctx.arc(cx, headY, headR * 0.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#e23b1e";
    ctx.beginPath();
    ctx.arc(cx, headY, headR * 0.26, 0, Math.PI * 2);
    ctx.fill();

    return ctx.canvas.toDataURL("image/png");
}

/**
 * A soft radial fireball glow for additive blending: white-hot core → warm orange
 * → transparent edge, with a small bright nucleus. The alpha ramp does the work.
 */
export function makeFireballDataUrl(size = 64): string {
    const ctx = makeCtx(size, size);
    const cx = size / 2;
    const r = size / 2;
    const g = ctx.createRadialGradient(cx, cx, 0, cx, cx, r);
    g.addColorStop(0.0, "rgba(255,255,245,1)");
    g.addColorStop(0.25, "rgba(255,236,150,0.95)");
    g.addColorStop(0.55, "rgba(255,140,40,0.65)");
    g.addColorStop(0.8, "rgba(220,70,20,0.25)");
    g.addColorStop(1.0, "rgba(180,40,10,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    // Hot nucleus.
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.beginPath();
    ctx.arc(cx, cx, size * 0.12, 0, Math.PI * 2);
    ctx.fill();
    return ctx.canvas.toDataURL("image/png");
}
