import { describe, expect, it } from "vitest";

import type { SpriteAtlas } from "../../../packages/babylon-lite/src/sprite/shared/sprite-atlas";
import { addSprite2DIndex, createSprite2DLayer, setSprite2DFrameIndex, updateSprite2DIndex } from "../../../packages/babylon-lite/src/sprite/sprite-2d";
import type { Sprite2DLayer } from "../../../packages/babylon-lite/src/sprite/sprite-2d";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d";

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
        frames: [
            { uvMin: [0, 0], uvMax: [0.25, 0.25], sourceSizePx: [32, 32], pivot: [0.5, 0.5] },
            { uvMin: [0.25, 0], uvMax: [0.5, 0.25], sourceSizePx: [32, 32], pivot: [0.5, 0.5] },
        ],
        premultipliedAlpha: false,
    };
}

/** `[uMin, vMin, uMax, vMax]` for slot 0. */
function uvs(layer: Sprite2DLayer): number[] {
    return Array.from(layer._instanceData.slice(4, 8));
}

describe("Sprite2D flipX/flipY", () => {
    it("treats flipX as absolute state, so re-sending it every frame is idempotent", () => {
        const layer = createSprite2DLayer(makeMockAtlas(), { capacity: 1 });
        const i = addSprite2DIndex(layer, { positionPx: [0, 0], sizePx: [32, 32], frame: 0 });

        // A game re-sends the current facing every tick alongside a moving position and
        // no `frame`. Every one of these must leave the sprite mirrored, not toggle it.
        for (let tick = 0; tick < 4; tick++) {
            updateSprite2DIndex(layer, i, { positionPx: [tick, 0], flipX: true });
            expect(uvs(layer)).toEqual([0.25, 0, 0, 0.25]);
        }
    });

    it("clears the flip when flipX is false, with or without a frame in the same patch", () => {
        const layer = createSprite2DLayer(makeMockAtlas(), { capacity: 1 });
        const i = addSprite2DIndex(layer, { positionPx: [0, 0], sizePx: [32, 32], frame: 0, flipX: true });
        expect(uvs(layer)).toEqual([0.25, 0, 0, 0.25]);

        updateSprite2DIndex(layer, i, { positionPx: [1, 0], flipX: false });
        expect(uvs(layer)).toEqual([0, 0, 0.25, 0.25]);

        updateSprite2DIndex(layer, i, { flipX: true });
        expect(uvs(layer)).toEqual([0.25, 0, 0, 0.25]);

        updateSprite2DIndex(layer, i, { frame: 0, flipX: false });
        expect(uvs(layer)).toEqual([0, 0, 0.25, 0.25]);
    });

    it("preserves the flip across a frame change that omits the flag", () => {
        const layer = createSprite2DLayer(makeMockAtlas(), { capacity: 1 });
        const i = addSprite2DIndex(layer, { positionPx: [0, 0], sizePx: [32, 32], frame: 0, flipX: true });

        // Same guarantee the animation path already gives via setSprite2DFrameIndex.
        updateSprite2DIndex(layer, i, { frame: 1 });
        expect(uvs(layer)).toEqual([0.5, 0, 0.25, 0.25]);

        setSprite2DFrameIndex(layer, i, 0);
        expect(uvs(layer)).toEqual([0.25, 0, 0, 0.25]);
    });

    it("applies the same absolute semantics to flipY", () => {
        const layer = createSprite2DLayer(makeMockAtlas(), { capacity: 1 });
        const i = addSprite2DIndex(layer, { positionPx: [0, 0], sizePx: [32, 32], frame: 0 });

        updateSprite2DIndex(layer, i, { flipY: true });
        updateSprite2DIndex(layer, i, { flipY: true });
        expect(uvs(layer)).toEqual([0, 0.25, 0.25, 0]);

        updateSprite2DIndex(layer, i, { flipY: false });
        expect(uvs(layer)).toEqual([0, 0, 0.25, 0.25]);
    });

    it("leaves both axes untouched when neither flag is supplied", () => {
        const layer = createSprite2DLayer(makeMockAtlas(), { capacity: 1 });
        const i = addSprite2DIndex(layer, { positionPx: [0, 0], sizePx: [32, 32], frame: 0, flipX: true, flipY: true });

        updateSprite2DIndex(layer, i, { positionPx: [9, 9] });

        expect(uvs(layer)).toEqual([0.25, 0.25, 0, 0]);
    });
});
