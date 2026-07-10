import { describe, expect, it } from "vitest";

import type { SpriteAtlas } from "../../../packages/babylon-lite/src/sprite/shared/sprite-atlas";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d";
import { addSprite2DIndex, createSprite2DLayer, updateSprite2DIndex } from "../../../packages/babylon-lite/src/sprite/sprite-2d";
import { pickSprite2D } from "../../../packages/babylon-lite/src/sprite/picking/pick-sprite-2d";

function makeMockAtlas(): SpriteAtlas {
    const texture = {
        texture: {} as GPUTexture,
        view: {} as GPUTextureView,
        sampler: {} as GPUSampler,
        width: 128,
        height: 128,
    } satisfies Texture2D;

    return {
        texture,
        textureSizePx: [128, 128],
        frames: [{ uvMin: [0, 0], uvMax: [0.25, 0.25], sourceSizePx: [32, 32], pivot: [0.5, 0.5] }],
        premultipliedAlpha: false,
    };
}

describe("pickSprite2D", () => {
    it("hits a centered sprite and reports center UV", () => {
        const layer = createSprite2DLayer(makeMockAtlas());
        const idx = addSprite2DIndex(layer, { positionPx: [100, 100], sizePx: [40, 20] });

        const hit = pickSprite2D([layer], 100, 100);
        expect(hit).not.toBeNull();
        expect(hit!.layer).toBe(layer);
        expect(hit!.spriteIndex).toBe(idx);
        // Default pivot [0.5, 0.5] → the sprite center maps to UV (0.5, 0.5).
        expect(hit!.u).toBeCloseTo(0.5, 6);
        expect(hit!.v).toBeCloseTo(0.5, 6);
    });

    it("returns null when the point is outside every sprite", () => {
        const layer = createSprite2DLayer(makeMockAtlas());
        addSprite2DIndex(layer, { positionPx: [100, 100], sizePx: [40, 20] });

        // Just past the right edge (center 100 ± half-width 20 → [80, 120]).
        expect(pickSprite2D([layer], 121, 100)).toBeNull();
        // Just past the bottom edge (center 100 ± half-height 10 → [90, 110]).
        expect(pickSprite2D([layer], 100, 111)).toBeNull();
    });

    it("respects the rectangle edges for a center-pivot sprite", () => {
        const layer = createSprite2DLayer(makeMockAtlas());
        addSprite2DIndex(layer, { positionPx: [100, 100], sizePx: [40, 20] });

        // Corners of the [80,120] × [90,110] rectangle are inside (inclusive).
        expect(pickSprite2D([layer], 80, 90)).not.toBeNull();
        expect(pickSprite2D([layer], 120, 110)).not.toBeNull();
        // A hair outside is a miss.
        expect(pickSprite2D([layer], 79.9, 100)).toBeNull();
    });

    it("honors a non-center pivot (top-left)", () => {
        const layer = createSprite2DLayer(makeMockAtlas(), { pivot: [0, 0] });
        addSprite2DIndex(layer, { positionPx: [100, 100], sizePx: [40, 20] });

        // With pivot top-left, positionPx is the top-left corner → quad covers [100,140] × [100,120].
        expect(pickSprite2D([layer], 100, 100)).not.toBeNull();
        expect(pickSprite2D([layer], 139, 119)).not.toBeNull();
        // The old center area is now off the quad.
        expect(pickSprite2D([layer], 90, 90)).toBeNull();
    });

    it("inverts sprite rotation (90°)", () => {
        const layer = createSprite2DLayer(makeMockAtlas());
        // Tall-thin sprite (10 wide, 40 tall) rotated 90° becomes wide-short on screen.
        addSprite2DIndex(layer, { positionPx: [100, 100], sizePx: [10, 40], rotation: Math.PI / 2 });

        // After a +90° rotation the 40px height extends along X → ±20 in X, ±5 in Y.
        expect(pickSprite2D([layer], 118, 100)).not.toBeNull();
        expect(pickSprite2D([layer], 100, 118)).toBeNull();
    });

    it("skips hidden sprites (visible: false)", () => {
        const layer = createSprite2DLayer(makeMockAtlas());
        const idx = addSprite2DIndex(layer, { positionPx: [100, 100], sizePx: [40, 20] });

        expect(pickSprite2D([layer], 100, 100)).not.toBeNull();
        updateSprite2DIndex(layer, idx, { visible: false });
        expect(pickSprite2D([layer], 100, 100)).toBeNull();
        // Restoring visibility (without re-supplying size) makes it pickable again.
        updateSprite2DIndex(layer, idx, { visible: true });
        expect(pickSprite2D([layer], 100, 100)).not.toBeNull();
    });

    it("skips an invisible layer", () => {
        const layer = createSprite2DLayer(makeMockAtlas());
        addSprite2DIndex(layer, { positionPx: [100, 100], sizePx: [40, 20] });

        layer.visible = false;
        expect(pickSprite2D([layer], 100, 100)).toBeNull();
    });

    it("returns the most-recently-added sprite when two overlap", () => {
        const layer = createSprite2DLayer(makeMockAtlas());
        addSprite2DIndex(layer, { positionPx: [100, 100], sizePx: [40, 40] });
        const top = addSprite2DIndex(layer, { positionPx: [100, 100], sizePx: [40, 40] });

        // Both cover the point; the later sprite is drawn on top, so it wins.
        expect(pickSprite2D([layer], 100, 100)!.spriteIndex).toBe(top);
    });

    it("prefers the topmost (last) layer", () => {
        const lower = createSprite2DLayer(makeMockAtlas());
        addSprite2DIndex(lower, { positionPx: [100, 100], sizePx: [40, 40] });
        const upper = createSprite2DLayer(makeMockAtlas());
        addSprite2DIndex(upper, { positionPx: [100, 100], sizePx: [40, 40] });

        // Layers are passed in draw order; the last one drawn (upper) wins.
        expect(pickSprite2D([lower, upper], 100, 100)!.layer).toBe(upper);
    });

    it("falls through to a lower layer when the upper layer misses", () => {
        const lower = createSprite2DLayer(makeMockAtlas());
        addSprite2DIndex(lower, { positionPx: [100, 100], sizePx: [40, 40] });
        const upper = createSprite2DLayer(makeMockAtlas());
        addSprite2DIndex(upper, { positionPx: [300, 300], sizePx: [40, 40] });

        const hit = pickSprite2D([lower, upper], 100, 100);
        expect(hit!.layer).toBe(lower);
    });

    it("returns null for an empty layer set", () => {
        expect(pickSprite2D([], 0, 0)).toBeNull();
    });
});
