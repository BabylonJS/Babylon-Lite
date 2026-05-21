import { describe, expect, it } from "vitest";

import type { BillboardSpriteSystem } from "../../packages/babylon-lite/src/sprite/billboard-sprite";
import { addBillboardSpriteIndex, clearBillboardSprites, createFacingBillboardSystem, removeBillboardSpriteIndex } from "../../packages/babylon-lite/src/sprite/billboard-sprite";
import {
    addBillboardSprite,
    getBillboardSpriteHandleIndex,
    isBillboardSpriteHandleAlive,
    removeBillboardSprite,
    setBillboardSpriteFrame,
    updateBillboardSprite,
} from "../../packages/babylon-lite/src/sprite/billboard-sprite-handle";
import type { SpriteAtlas } from "../../packages/babylon-lite/src/sprite/shared/sprite-atlas";
import type { Sprite2DLayer } from "../../packages/babylon-lite/src/sprite/sprite-2d";
import { addSprite2DIndex, clearSprite2DLayer, createSprite2DLayer, removeSprite2DIndex } from "../../packages/babylon-lite/src/sprite/sprite-2d";
import {
    addSprite2D,
    getSprite2DHandleIndex,
    isSprite2DHandleAlive,
    removeSprite2D,
    setSprite2DFrame,
    updateSprite2D,
} from "../../packages/babylon-lite/src/sprite/sprite-2d-handle";
import type { Texture2D } from "../../packages/babylon-lite/src/texture/texture-2d";

interface WithOptionalHandleState {
    readonly _handleHooks?: unknown;
    readonly _handleState?: unknown;
}

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

function privateState(target: Sprite2DLayer | BillboardSpriteSystem): WithOptionalHandleState {
    return target as WithOptionalHandleState;
}

describe("Sprite2DHandle", () => {
    it("does not install handle state for index-only Sprite2D usage", () => {
        const layer = createSprite2DLayer(makeMockAtlas(), { capacity: 1 });
        addSprite2DIndex(layer, { positionPx: [1, 2], sizePx: [3, 4] });
        addSprite2DIndex(layer, { positionPx: [5, 6], sizePx: [7, 8] });

        expect(layer.count).toBe(2);
        expect(privateState(layer)._handleHooks).toBeUndefined();
        expect(privateState(layer)._handleState).toBeUndefined();
    });

    it("allocates stable ids lazily and tracks swap-removes through the index API", () => {
        const layer = createSprite2DLayer(makeMockAtlas(), { capacity: 1 });
        const first = addSprite2D(layer, { positionPx: [10, 0], sizePx: [1, 1] });
        const middle = addSprite2D(layer, { positionPx: [20, 0], sizePx: [2, 2] });
        const last = addSprite2D(layer, { positionPx: [30, 0], sizePx: [3, 3] });

        expect(first.id).toBe(1);
        expect(middle.id).toBe(2);
        expect(last.id).toBe(3);
        expect(privateState(layer)._handleHooks).toBeDefined();

        removeSprite2DIndex(layer, 0);

        expect(isSprite2DHandleAlive(first)).toBe(false);
        expect(getSprite2DHandleIndex(last)).toBe(0);
        expect(getSprite2DHandleIndex(middle)).toBe(1);
        expect(() => getSprite2DHandleIndex(first)).toThrow(/removed/);

        updateSprite2D(last, { positionPx: [300, 4] });
        expect(layer._instanceData[0]).toBe(300);
        expect(layer._instanceData[1]).toBe(4);

        setSprite2DFrame(last, 1);
        expect(layer._instanceData[4]).toBe(0.25);
        expect(layer._instanceData[5]).toBe(0);
        expect(layer._instanceData[6]).toBe(0.5);
        expect(layer._instanceData[7]).toBe(0.25);
    });

    it("supports depth-hosted Sprite2D layers with the same stable ids", () => {
        const layer = createSprite2DLayer(makeMockAtlas(), { capacity: 1, depth: "test-write", layerZ: 0.25 });
        const first = addSprite2D(layer, { positionPx: [10, 0], sizePx: [1, 1] });
        const last = addSprite2D(layer, { positionPx: [30, 0], sizePx: [3, 3], z: 0.75 });

        expect(layer._instanceFloatsPerSprite).toBe(14);
        expect(layer._instanceData[13]).toBe(0.25);
        expect(layer._instanceData[layer._instanceFloatsPerSprite + 13]).toBe(0.75);

        removeSprite2DIndex(layer, 0);

        expect(isSprite2DHandleAlive(first)).toBe(false);
        expect(getSprite2DHandleIndex(last)).toBe(0);

        updateSprite2D(last, { z: 0.5 });
        expect(layer._instanceData[13]).toBe(0.5);
    });

    it("removes by handle and invalidates handles on clear", () => {
        const layer = createSprite2DLayer(makeMockAtlas());
        const first = addSprite2D(layer, { positionPx: [1, 0], sizePx: [1, 1] });
        const middle = addSprite2D(layer, { positionPx: [2, 0], sizePx: [2, 2] });
        const last = addSprite2D(layer, { positionPx: [3, 0], sizePx: [3, 3] });

        removeSprite2D(middle);

        expect(layer.count).toBe(2);
        expect(isSprite2DHandleAlive(middle)).toBe(false);
        expect(getSprite2DHandleIndex(first)).toBe(0);
        expect(getSprite2DHandleIndex(last)).toBe(1);

        removeSprite2D(middle);
        expect(layer.count).toBe(2);

        clearSprite2DLayer(layer);
        clearSprite2DLayer(layer);
        expect(isSprite2DHandleAlive(first)).toBe(false);
        expect(isSprite2DHandleAlive(last)).toBe(false);
        expect(() => updateSprite2D(last, { positionPx: [9, 9] })).toThrow(/removed/);
    });
});

describe("BillboardSpriteHandle", () => {
    it("does not install handle state for index-only billboard usage", () => {
        const system = createFacingBillboardSystem(makeMockAtlas(), { capacity: 1 });
        addBillboardSpriteIndex(system, { position: [1, 2, 3], sizeWorld: [4, 5] });
        addBillboardSpriteIndex(system, { position: [6, 7, 8], sizeWorld: [9, 10] });

        expect(system.count).toBe(2);
        expect(privateState(system)._handleHooks).toBeUndefined();
        expect(privateState(system)._handleState).toBeUndefined();
    });

    it("allocates stable ids lazily and tracks billboard swap-removes", () => {
        const system = createFacingBillboardSystem(makeMockAtlas(), { capacity: 1 });
        const first = addBillboardSprite(system, { position: [10, 0, 0], sizeWorld: [1, 1] });
        const middle = addBillboardSprite(system, { position: [20, 0, 0], sizeWorld: [2, 2] });
        const last = addBillboardSprite(system, { position: [30, 0, 0], sizeWorld: [3, 3] });

        expect(first.id).toBe(1);
        expect(middle.id).toBe(2);
        expect(last.id).toBe(3);
        expect(privateState(system)._handleHooks).toBeDefined();

        removeBillboardSpriteIndex(system, 1);

        expect(isBillboardSpriteHandleAlive(middle)).toBe(false);
        expect(getBillboardSpriteHandleIndex(first)).toBe(0);
        expect(getBillboardSpriteHandleIndex(last)).toBe(1);
        expect(() => getBillboardSpriteHandleIndex(middle)).toThrow(/removed/);

        updateBillboardSprite(last, { position: [300, 4, 5] });
        const base = getBillboardSpriteHandleIndex(last) * system._instanceFloatsPerSprite;
        expect(system._instanceData[base]).toBe(300);
        expect(system._instanceData[base + 1]).toBe(4);
        expect(system._instanceData[base + 2]).toBe(5);

        setBillboardSpriteFrame(last, 1);
        expect(system._instanceData[base + 5]).toBe(0.25);
        expect(system._instanceData[base + 6]).toBe(0);
        expect(system._instanceData[base + 7]).toBe(0.5);
        expect(system._instanceData[base + 8]).toBe(0.25);
    });

    it("removes billboards by handle and invalidates handles on clear", () => {
        const system = createFacingBillboardSystem(makeMockAtlas());
        const first = addBillboardSprite(system, { position: [1, 0, 0], sizeWorld: [1, 1] });
        const middle = addBillboardSprite(system, { position: [2, 0, 0], sizeWorld: [2, 2] });
        const last = addBillboardSprite(system, { position: [3, 0, 0], sizeWorld: [3, 3] });

        removeBillboardSprite(middle);

        expect(system.count).toBe(2);
        expect(isBillboardSpriteHandleAlive(middle)).toBe(false);
        expect(getBillboardSpriteHandleIndex(first)).toBe(0);
        expect(getBillboardSpriteHandleIndex(last)).toBe(1);

        removeBillboardSprite(middle);
        expect(system.count).toBe(2);

        clearBillboardSprites(system);
        clearBillboardSprites(system);
        expect(isBillboardSpriteHandleAlive(first)).toBe(false);
        expect(isBillboardSpriteHandleAlive(last)).toBe(false);
        expect(() => updateBillboardSprite(last, { position: [9, 9, 9] })).toThrow(/removed/);
    });
});
