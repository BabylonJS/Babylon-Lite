// Faithful DOOM sprite rendering: camera-facing billboards drawn through the same
// palette + COLORMAP path as the world, so monsters/items get correct banded light
// diminishing and depth occlusion against walls.
//
// All visible mobjs are pushed into ONE facing billboard system (cleared + refilled
// once per render frame). The engine owns the quad geometry, instancing, sorting and
// depth; we supply only a custom WGSL fragment that does the palette-index + COLORMAP
// lookup, with the per-sprite light level / full-bright flag carried in the instance
// `color` (tint) and the camera distance read from `in.viewDist`.

import {
    addBillboardSpriteIndex,
    addFacingBillboardSystem,
    billboardBlendCutout,
    clearBillboardSprites,
    createBillboardCustomShader,
    createFacingBillboardSystem,
    type FacingBillboardSpriteSystem,
    type SceneContext,
    type Texture2D,
} from "babylon-lite";
import type { SpriteImage, SpriteStore } from "./sprites.js";

const DIST_PER_BAND = 224.0;

// Fragment body for `createBillboardCustomShader`. In scope: `in.uv`, `in.tint`
// (r = sector light 0..1, g = full-bright flag), `in.viewDist` (camera→anchor in
// world units), the atlas (`atlasTex`/`atlasSamp`) and the `colormap` extra texture
// (`colormapTex`/`colormapSamp`). Mirrors the wall material's distance-blended
// COLORMAP banding so sprites depth-cue identically to the geometry around them.
const fragmentSource = `let src = textureSample(atlasTex, atlasSamp, in.uv);
if (src.a < 0.5) { discard; }
let idx = floor(src.r * 255.0 + 0.5);
let sectorLight = in.tint.x * 255.0;
let fullbright = in.tint.y;
let baseRow = clamp(31.0 - floor(sectorLight / 8.0), 0.0, 31.0);
let lightRow = clamp(baseRow + in.viewDist / ${DIST_PER_BAND.toFixed(1)}, 0.0, 31.0);
let row = mix(lightRow, 0.0, step(0.5, fullbright));
let r0 = floor(row);
let r1 = min(r0 + 1.0, 31.0);
let frac = row - r0;
let u = (idx + 0.5) / 256.0;
let c0 = textureSample(colormapTex, colormapSamp, vec2<f32>(u, (r0 + 0.5) / 34.0));
let c1 = textureSample(colormapTex, colormapSamp, vec2<f32>(u, (r1 + 0.5) / 34.0));
let lut = mix(c0, c1, frac);
return vec4<f32>(lut.rgb, 1.0);`;

/** A single mobj to draw this frame. */
export interface RenderSprite {
    /** Doom map X (world X). */
    x: number;
    /** Vertical origin (world Y / Doom z). */
    z: number;
    /** Doom map Y (world Z). */
    y: number;
    image: SpriteImage;
    /** Sector light 0..255. */
    light: number;
    fullbright: boolean;
}

export class SpriteRenderer {
    private readonly system: FacingBillboardSpriteSystem;

    constructor(scene: SceneContext, store: SpriteStore, colormapTex: Texture2D) {
        const atlas = store.spriteAtlas;
        if (!atlas) {
            throw new Error("SpriteRenderer requires a built sprite atlas (call SpriteStore.build first).");
        }
        const customShader = createBillboardCustomShader({
            fragment: fragmentSource,
            extraTextures: [{ name: "colormap", texture: colormapTex }],
        });
        this.system = createFacingBillboardSystem(atlas, {
            capacity: 256,
            blendMode: billboardBlendCutout,
            alphaCutoff: 0.5,
            customShader,
        });
        // Must register BEFORE `registerScene` runs: the scene drains its deferred
        // renderable builders exactly once at registration, so a system added later
        // (e.g. lazily inside the render loop) would never be built or drawn.
        addFacingBillboardSystem(scene, this.system);
    }

    /** Refills the billboard system from the given visible sprites (call once/frame). */
    rebuild(sprites: RenderSprite[]): void {
        clearBillboardSprites(this.system);
        for (const s of sprites) {
            const img = s.image;
            // The frame's pre-baked pivot anchors the quad at the mobj origin; `flipX`
            // handles mirrored rotation slots (the pivot X is already mirror-aware).
            addBillboardSpriteIndex(this.system, {
                position: [s.x, s.z, s.y],
                sizeWorld: [img.aw, img.ah],
                frame: img.frameIndex,
                color: [s.light / 255, s.fullbright ? 1 : 0, 0, 1],
                flipX: img.mirror,
                flipY: false,
            });
        }
    }

    dispose(): void {
        clearBillboardSprites(this.system);
    }
}
