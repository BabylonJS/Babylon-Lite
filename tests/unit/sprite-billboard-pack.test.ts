/**
 * sprite-billboard-pack.test.ts — Per-instance layout verification for
 * BillboardSpriteSystem (24 floats / 96 B). Mirrors §6 layout in
 * docs/architecture/26-sprites.md.
 *
 * Verifies:
 * - Stride is 24 floats.
 * - Slots 3, 4, 5 (anchored's depthBias + offsetPx) are reserved zeros.
 * - Slots 6..7 carry sizeWorld (not sizePx).
 * - Invisible sprites collapse sizeWorld to [0, 0].
 * - Swap-remove + update-merge behave like the anchored counterpart.
 */

import { describe, it, expect } from "vitest";
import { createGridSpriteAtlas } from "../../packages/babylon-lite/src/sprite/shared/sprite-atlas";
import { addBillboardSprite, removeBillboardSprite, SPRITE_BILLBOARD_STRIDE, updateBillboardSprite } from "../../packages/babylon-lite/src/sprite/sprite-billboard-shared";
import { createFacingBillboardSystem } from "../../packages/babylon-lite/src/sprite/sprite-billboard-facing";
import { createYawLockedBillboardSystem } from "../../packages/babylon-lite/src/sprite/sprite-billboard-yaw";
import { createAxisLockedBillboardSystem } from "../../packages/babylon-lite/src/sprite/sprite-billboard-axis";
import type { Texture2D } from "../../packages/babylon-lite/src/texture/texture-2d";

function fakeAtlas() {
    const tex: Texture2D = { texture: {} as GPUTexture, view: {} as GPUTextureView, sampler: {} as GPUSampler, width: 64, height: 64 };
    return createGridSpriteAtlas(tex, { cellWidthPx: 16, cellHeightPx: 16 });
}

describe("Billboard sprite per-instance layout", () => {
    it("stride is 24 floats (96 bytes)", () => {
        expect(SPRITE_BILLBOARD_STRIDE).toBe(24);
    });

    it("packs each field at the documented offset (Facing variant)", () => {
        const system = createFacingBillboardSystem(fakeAtlas());
        addBillboardSprite(system, {
            position: [1, 2, 3],
            sizeWorld: [4, 5],
            pivot: [0.25, 0.75],
            rotation: 0,
            color: [0.1, 0.2, 0.3, 0.4],
            flipX: true,
            flipY: false,
        });
        const d = system._storage.data;
        expect(Array.from(d.subarray(0, 3))).toEqual([1, 2, 3]);
        // Slots 3, 4, 5 are reserved (anchored uses depthBias + offsetPx here).
        expect(d[3]).toBe(0);
        expect(d[4]).toBe(0);
        expect(d[5]).toBe(0);
        // sizeWorld
        expect(Array.from(d.subarray(6, 8))).toEqual([4, 5]);
        // pivot
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

    it("invisible sprite collapses sizeWorld to [0, 0]", () => {
        const system = createYawLockedBillboardSystem(fakeAtlas());
        const i = addBillboardSprite(system, { position: [0, 0, 0], sizeWorld: [10, 10], visible: false });
        const off = i * SPRITE_BILLBOARD_STRIDE;
        expect(system._storage.data[off + 6]).toBe(0);
        expect(system._storage.data[off + 7]).toBe(0);
    });

    it("swap-remove keeps remaining slots packed contiguously", () => {
        const system = createFacingBillboardSystem(fakeAtlas());
        addBillboardSprite(system, { position: [1, 0, 0], sizeWorld: [1, 1] });
        addBillboardSprite(system, { position: [2, 0, 0], sizeWorld: [1, 1] });
        addBillboardSprite(system, { position: [3, 0, 0], sizeWorld: [1, 1] });
        removeBillboardSprite(system, 0);
        expect(system.count).toBe(2);
        expect(system._storage.data[0]).toBe(3);
        expect(system._storage.data[SPRITE_BILLBOARD_STRIDE]).toBe(2);
    });

    it("update merges patch over current slot data", () => {
        const system = createFacingBillboardSystem(fakeAtlas());
        const i = addBillboardSprite(system, { position: [0, 0, 0], sizeWorld: [2, 3], color: [1, 0, 0, 1] });
        updateBillboardSprite(system, i, { position: [5, 5, 5] });
        const d = system._storage.data;
        expect(Array.from(d.subarray(0, 3))).toEqual([5, 5, 5]);
        // Color preserved.
        expect(Array.from(d.subarray(16, 20))).toEqual([1, 0, 0, 1]);
        // sizeWorld preserved.
        expect(Array.from(d.subarray(6, 8))).toEqual([2, 3]);
    });
});

describe("Billboard variant tagging", () => {
    it("each factory tags its variant + lock axis", () => {
        const facing = createFacingBillboardSystem(fakeAtlas());
        expect(facing._variant).toBe("facing");
        expect(facing._lockAxis).toBeNull();

        const yaw = createYawLockedBillboardSystem(fakeAtlas());
        expect(yaw._variant).toBe("yaw");
        expect(yaw._lockAxis).toBeNull();

        const axis = createAxisLockedBillboardSystem(fakeAtlas(), [2, 0, 0]);
        expect(axis._variant).toBe("axis");
        // Axis is normalized at creation.
        expect(axis._lockAxis).toEqual([1, 0, 0]);
    });

    it("axis-locked default depthWrite follows blendMode", () => {
        const blended = createAxisLockedBillboardSystem(fakeAtlas(), [0, 1, 0]);
        expect(blended.depthWrite).toBe(false);
        const cutout = createAxisLockedBillboardSystem(fakeAtlas(), [0, 1, 0], { blendMode: "cutout" });
        expect(cutout.depthWrite).toBe(true);
    });

    it("entity type is 'billboard-sprite-system' for all three variants", () => {
        expect(createFacingBillboardSystem(fakeAtlas())._entityType).toBe("billboard-sprite-system");
        expect(createYawLockedBillboardSystem(fakeAtlas())._entityType).toBe("billboard-sprite-system");
        expect(createAxisLockedBillboardSystem(fakeAtlas(), [0, 1, 0])._entityType).toBe("billboard-sprite-system");
    });
});
