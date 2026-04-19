/**
 * sprite-anchored-pack.test.ts — Per-instance layout verification for
 * AnchoredSpriteLayer (24 floats / 96 B). Mirrors §6 layout in
 * docs/architecture/26-sprites.md.
 */

import { describe, it, expect } from "vitest";
import { createGridSpriteAtlas } from "../../packages/babylon-lite/src/sprite/shared/sprite-atlas";
import {
    addAnchoredSprite,
    createAnchoredSpriteLayer,
    removeAnchoredSprite,
    SPRITE_ANCHORED_STRIDE,
    updateAnchoredSprite,
} from "../../packages/babylon-lite/src/sprite/sprite-anchored";
import type { Texture2D } from "../../packages/babylon-lite/src/texture/texture-2d";

function fakeAtlas() {
    const tex: Texture2D = { texture: {} as GPUTexture, view: {} as GPUTextureView, sampler: {} as GPUSampler, width: 64, height: 64 };
    return createGridSpriteAtlas(tex, { cellWidthPx: 16, cellHeightPx: 16 });
}

describe("Anchored sprite per-instance layout", () => {
    it("stride is 24 floats (96 bytes)", () => {
        expect(SPRITE_ANCHORED_STRIDE).toBe(24);
    });

    it("packs each field at the documented offset", () => {
        const layer = createAnchoredSpriteLayer(fakeAtlas());
        addAnchoredSprite(layer, {
            position: [1, 2, 3],
            depthBias: 0.5,
            offsetPx: [10, -10],
            sizePx: [50, 60],
            pivot: [0.25, 0.75],
            rotation: 0,
            color: [0.1, 0.2, 0.3, 0.4],
            flipX: true,
            flipY: false,
        });
        const d = layer._storage.data;
        expect(Array.from(d.subarray(0, 3))).toEqual([1, 2, 3]);
        expect(d[3]).toBeCloseTo(0.5);
        expect(Array.from(d.subarray(4, 6))).toEqual([10, -10]);
        expect(Array.from(d.subarray(6, 8))).toEqual([50, 60]);
        expect(Array.from(d.subarray(8, 10))).toEqual([0.25, 0.75]);
        // sinCos for rotation=0 → sin=0, cos=1
        expect(d[10]).toBeCloseTo(0);
        expect(d[11]).toBeCloseTo(1);
        // uvRect — frame 0 of a 64×64 atlas with 16×16 cells → uv (0,0..0.25,0.25)
        expect(Array.from(d.subarray(12, 16))).toEqual([0, 0, 0.25, 0.25]);
        expect(Array.from(d.subarray(16, 20)).map((v) => +v.toFixed(4))).toEqual([0.1, 0.2, 0.3, 0.4]);
        // flagsAndPad: flipX=1, flipY=0, pickable=1 (default), pad=0
        expect(Array.from(d.subarray(20, 24))).toEqual([1, 0, 1, 0]);
    });

    it("invisible sprite collapses sizePx to [0, 0]", () => {
        const layer = createAnchoredSpriteLayer(fakeAtlas());
        const i = addAnchoredSprite(layer, { position: [0, 0, 0], sizePx: [40, 40], visible: false });
        const off = i * SPRITE_ANCHORED_STRIDE;
        expect(layer._storage.data[off + 6]).toBe(0);
        expect(layer._storage.data[off + 7]).toBe(0);
    });

    it("swap-remove keeps remaining slots packed contiguously", () => {
        const layer = createAnchoredSpriteLayer(fakeAtlas());
        addAnchoredSprite(layer, { position: [1, 0, 0] });
        addAnchoredSprite(layer, { position: [2, 0, 0] });
        addAnchoredSprite(layer, { position: [3, 0, 0] });
        removeAnchoredSprite(layer, 0);
        expect(layer.count).toBe(2);
        // Slot 0 now holds what was the last slot (position.x = 3).
        expect(layer._storage.data[0]).toBe(3);
        // Slot 1 still holds the middle entry (position.x = 2).
        expect(layer._storage.data[SPRITE_ANCHORED_STRIDE]).toBe(2);
    });

    it("update merges patch over current slot data", () => {
        const layer = createAnchoredSpriteLayer(fakeAtlas());
        const i = addAnchoredSprite(layer, { position: [0, 0, 0], sizePx: [10, 10], color: [1, 0, 0, 1] });
        updateAnchoredSprite(layer, i, { position: [5, 5, 5] });
        const d = layer._storage.data;
        expect(Array.from(d.subarray(0, 3))).toEqual([5, 5, 5]);
        // Color preserved.
        expect(Array.from(d.subarray(16, 20))).toEqual([1, 0, 0, 1]);
        // Size preserved.
        expect(Array.from(d.subarray(6, 8))).toEqual([10, 10]);
    });
});
