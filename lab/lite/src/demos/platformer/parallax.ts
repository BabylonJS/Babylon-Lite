/**
 * Multi-band parallax background for the platformer demo.
 *
 * Showcases Lite's opt-in per-sprite **`uvScroll`** feature: each depth band is a
 * SINGLE full-screen sprite whose atlas frame samples a tileable texture more than
 * once across the screen (`uvMax.x > 1`, `repeat` wrap). Scrolling the band is then
 * just advancing that sprite's `uvOffset.x` each frame via `setSprite2DUvOffset` —
 * no manual tile-wrapping bookkeeping, and the texture repeats infinitely. Farther
 * bands scroll slower (smaller parallax factor), so the world gains depth.
 *
 * The band textures are generated procedurally with an offscreen 2D canvas (sky
 * gradient, drifting clouds, two rows of rolling hills) and uploaded once. Only the
 * nearest two hill bands and the clouds scroll; the sky is a static gradient.
 *
 * Pure data path: no scene, camera, or mesh — just `Sprite2DLayer`s drawn by the
 * shared `SpriteRenderer`, behind the gameplay layers.
 */

import {
    addSprite2DIndex,
    createSprite2DLayer,
    loadTexture2D,
    setSprite2DUvOffset,
    spriteBlendPremultiplied,
    updateSprite2DIndex,
    type EngineContext,
    type Sprite2DLayer,
    type SpriteAtlas,
} from "babylon-lite";

/** A single parallax depth band: one full-screen sprite sampling a tileable texture. */
interface Band {
    layer: Sprite2DLayer;
    slot: number;
    /** Screen scroll speed as a fraction of camera motion (0 = static, larger = nearer). */
    factor: number;
    /** Horizontal texture repeats across the screen (the frame's `uvMax.x`). */
    repeats: number;
    /** Self-drift in UV units/sec (clouds keep moving when the camera is still). */
    drift: number;
    /** Vertical placement as fractions of canvas height: top edge and band height. */
    topFrac: number;
    heightFrac: number;
    /** Whether this band scrolls (false = the static sky gradient). */
    scroll: boolean;
}

/** The parallax system: its layers (to register, back-to-front) and a per-frame update. */
export interface Parallax {
    /** Background layers in draw order; spread into the `SpriteRenderer` layers list. */
    readonly layers: readonly Sprite2DLayer[];
    /** Re-place + scroll every band. Call once per frame from the render projection. */
    update(cameraXWorld: number, timeSec: number, canvasWidth: number, canvasHeight: number): void;
}

// ── Procedural texture helpers ────────────────────────────────────────────────

/** Small deterministic PRNG so the cloud field looks the same every run. */
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function makeCtx(w: number, h: number): CanvasRenderingContext2D {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d", { alpha: true })!;
    ctx.imageSmoothingEnabled = true;
    return ctx;
}

/** Vertical sky gradient (deep blue → pale horizon haze). */
function drawSky(w: number, h: number): string {
    const ctx = makeCtx(w, h);
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0.0, "#4f93ea");
    g.addColorStop(0.45, "#7fb4f0");
    g.addColorStop(0.78, "#bfe1f6");
    g.addColorStop(1.0, "#e9f6fb");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    return ctx.canvas.toDataURL("image/png");
}

/** Fluffy solid-white cloud puffs on transparent, tileable across width `w`. */
function drawClouds(w: number, h: number): string {
    const ctx = makeCtx(w, h);
    const rnd = mulberry32(0x51a7);
    const lobes: readonly [number, number, number][] = [
        [0, 0, 34],
        [-30, 8, 24],
        [30, 6, 26],
        [-14, -12, 22],
        [16, -11, 20],
        [2, 11, 30],
    ];
    const puffs = 5;
    ctx.fillStyle = "#ffffff";
    for (let i = 0; i < puffs; i++) {
        const cx = (i + 0.5 + (rnd() - 0.5) * 0.7) * (w / puffs);
        const cy = h * 0.34 + rnd() * h * 0.32;
        const s = 0.85 + rnd() * 0.6;
        // Draw the puff plus its horizontal wrap copies so it tiles seamlessly.
        for (const dx of [0, -w, w]) {
            const x = cx + dx;
            if (x < -160 || x > w + 160) continue;
            for (const [ox, oy, r] of lobes) {
                ctx.beginPath();
                ctx.arc(x + ox * s, cy + oy * s, r * s, 0, Math.PI * 2);
                ctx.fill();
            }
        }
    }
    return ctx.canvas.toDataURL("image/png");
}

/** A row of rolling hills (solid fill + lighter crest rim) on transparent, tileable. */
function drawHills(
    w: number,
    h: number,
    opts: { crestFrac: number; ampFrac: number; fill: string; rim: string; rimPx: number; f1: number; f2: number; phase: number },
): string {
    const ctx = makeCtx(w, h);
    const baseY = h * opts.crestFrac;
    const amp = h * opts.ampFrac;
    const crest = (x: number): number => {
        const a = 0.5 + 0.5 * Math.sin((2 * Math.PI * opts.f1 * x) / w + opts.phase);
        const b = 0.5 + 0.5 * Math.sin((2 * Math.PI * opts.f2 * x) / w + opts.phase * 1.7 + 1.3);
        return baseY - amp * (0.65 * a + 0.35 * b);
    };
    // Filled silhouette down to the bottom edge.
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x <= w; x += 2) ctx.lineTo(x, crest(x));
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = opts.fill;
    ctx.fill();
    // Lighter rim along the crest.
    ctx.beginPath();
    for (let x = 0; x <= w; x += 2) {
        const y = crest(x);
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = opts.rim;
    ctx.lineWidth = opts.rimPx;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();
    return ctx.canvas.toDataURL("image/png");
}

// ── Band construction ─────────────────────────────────────────────────────────

/** Build one band: load its texture, wrap it in a 1-frame atlas whose `uvMax.x` tiles it. */
async function makeBand(
    engine: EngineContext,
    dataUrl: string,
    order: number,
    cfg: { factor: number; repeats: number; drift: number; topFrac: number; heightFrac: number; scroll: boolean; tint?: readonly [number, number, number, number] },
): Promise<Band> {
    const texture = await loadTexture2D(engine, dataUrl, {
        invertY: false,
        addressModeU: cfg.scroll ? "repeat" : "clamp-to-edge",
        addressModeV: "clamp-to-edge",
        mipMaps: false,
        minFilter: "linear",
        magFilter: "linear",
        // Premultiplied alpha so bilinear filtering at the transparent crest/cloud
        // edges blends correctly (straight alpha bleeds the transparent-black texels
        // into a dark fringe; premultiplied makes them contribute zero).
        premultiplyAlpha: true,
    });
    // A single frame whose U spans [0, repeats]: under `repeat` wrap the texture
    // tiles `repeats` times across the sprite; adding `uvOffset.x` scrolls it.
    const atlas: SpriteAtlas = {
        texture,
        textureSizePx: [texture.width, texture.height],
        frames: [{ uvMin: [0, 0], uvMax: [cfg.repeats, 1], sourceSizePx: [texture.width, texture.height], pivot: [0, 0] }],
        premultipliedAlpha: true,
    };
    const layer = createSprite2DLayer(atlas, { capacity: 1, order, pivot: [0, 0], uvScroll: cfg.scroll, blendMode: spriteBlendPremultiplied });
    const slot = addSprite2DIndex(layer, {
        positionPx: [0, 0],
        sizePx: [1, 1],
        frame: 0,
        color: cfg.tint ? [...cfg.tint] : [1, 1, 1, 1],
        ...(cfg.scroll ? { uvOffset: [0, 0] as [number, number] } : {}),
    });
    return { layer, slot, factor: cfg.factor, repeats: cfg.repeats, drift: cfg.drift, topFrac: cfg.topFrac, heightFrac: cfg.heightFrac, scroll: cfg.scroll };
}

/**
 * Build the parallax background: a static sky gradient, drifting clouds, and two
 * rows of rolling hills, each scrolling at its own rate. `baseOrder` is the draw
 * order of the backmost band; the four bands occupy `baseOrder .. baseOrder + 3`.
 */
export async function createParallax(engine: EngineContext, baseOrder: number): Promise<Parallax> {
    const sky = await makeBand(engine, drawSky(8, 256), baseOrder, { factor: 0, repeats: 1, drift: 0, topFrac: 0, heightFrac: 1, scroll: false });
    const clouds = await makeBand(engine, drawClouds(480, 200), baseOrder + 1, {
        factor: 0.06,
        repeats: 2,
        drift: 0.006,
        topFrac: 0.04,
        heightFrac: 0.46,
        scroll: true,
        // Premultiplied tint: scale all four channels for a uniform 90% opacity.
        tint: [0.9, 0.9, 0.9, 0.9],
    });
    const farHills = await makeBand(
        engine,
        drawHills(480, 200, { crestFrac: 0.46, ampFrac: 0.34, fill: "#a9d6bb", rim: "#c6e8cb", rimPx: 5, f1: 2, f2: 3, phase: 0.6 }),
        baseOrder + 2,
        { factor: 0.16, repeats: 2.4, drift: 0, topFrac: 0.4, heightFrac: 0.5, scroll: true },
    );
    const nearHills = await makeBand(
        engine,
        drawHills(480, 230, { crestFrac: 0.4, ampFrac: 0.42, fill: "#84c23f", rim: "#a8da5e", rimPx: 7, f1: 1, f2: 2, phase: 2.1 }),
        baseOrder + 3,
        { factor: 0.3, repeats: 3, drift: 0, topFrac: 0.5, heightFrac: 0.52, scroll: true },
    );

    const bands = [sky, clouds, farHills, nearHills];

    return {
        layers: bands.map((b) => b.layer),
        update(cameraXWorld, timeSec, cw, ch): void {
            for (const b of bands) {
                updateSprite2DIndex(b.layer, b.slot, { positionPx: [0, Math.round(b.topFrac * ch)], sizePx: [cw, Math.ceil(b.heightFrac * ch)] });
                if (b.scroll) {
                    const off = (cameraXWorld * b.factor * b.repeats) / cw + timeSec * b.drift;
                    setSprite2DUvOffset(b.layer, b.slot, [off, 0]);
                }
            }
        },
    };
}
