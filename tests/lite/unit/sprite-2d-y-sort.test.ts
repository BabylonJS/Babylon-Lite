import { describe, expect, it, vi } from "vitest";

import type { SpriteAtlas } from "../../../packages/babylon-lite/src/sprite/shared/sprite-atlas";
import { addSprite2DIndex, clearSprite2DLayer, createSprite2DLayer, removeSprite2DIndex, updateSprite2DIndex } from "../../../packages/babylon-lite/src/sprite/sprite-2d";
import { addSprite2D, getSprite2DHandleIndex, removeSprite2D } from "../../../packages/babylon-lite/src/sprite/sprite-2d-handle";
import { setSprite2DYSortHandleBias } from "../../../packages/babylon-lite/src/sprite/sprite-2d-handle-y-sort";
import { disableSprite2DYSort, enableSprite2DYSort, setSprite2DYSortBias } from "../../../packages/babylon-lite/src/sprite/sprite-2d-y-sort";
import { uploadSpriteInstances } from "../../../packages/babylon-lite/src/sprite/sprite-pipeline";
import { pickSprite2D } from "../../../packages/babylon-lite/src/sprite/picking/pick-sprite-2d";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d";

interface RecordedUpload {
    readonly offsetBytes: number;
    readonly data: Float32Array;
}

function makeMockAtlas(): SpriteAtlas {
    const texture = {
        texture: {} as GPUTexture,
        view: {} as GPUTextureView,
        sampler: {} as GPUSampler,
        width: 64,
        height: 64,
    } satisfies Texture2D;
    return {
        texture,
        textureSizePx: [64, 64],
        frames: [{ uvMin: [0, 0], uvMax: [1, 1], sourceSizePx: [64, 64], pivot: [0.5, 0.5] }],
        premultipliedAlpha: false,
    };
}

function addTaggedSprite(layer: ReturnType<typeof createSprite2DLayer>, y: number, tag: number, visible = true): number {
    return addSprite2DIndex(layer, {
        positionPx: [100, y],
        sizePx: [120, 120],
        color: [tag, 0, 0, 1],
        visible,
    });
}

function makeUploadDevice(): { device: GPUDevice; uploads: RecordedUpload[] } {
    const uploads: RecordedUpload[] = [];
    const writeBuffer = vi.fn((_destination: GPUBuffer, offsetBytes: number, source: ArrayBuffer, sourceOffset: number, size: number) => {
        const copy = new Uint8Array(size);
        copy.set(new Uint8Array(source, sourceOffset, size));
        uploads.push({ offsetBytes, data: new Float32Array(copy.buffer) });
    });
    return {
        device: { queue: { writeBuffer } } as unknown as GPUDevice,
        uploads,
    };
}

function uploadedTags(upload: RecordedUpload, stride: number): number[] {
    const tags: number[] = [];
    for (let base = 0; base < upload.data.length; base += stride) {
        tags.push(upload.data[base + 9]!);
    }
    return tags;
}

describe("Sprite2D Y-sort", () => {
    it("uploads stable ascending Y order without changing canonical logical storage", () => {
        const layer = createSprite2DLayer(makeMockAtlas(), { capacity: 3 });
        const high = addTaggedSprite(layer, 30, 30);
        const low = addTaggedSprite(layer, 10, 10);
        const middle = addTaggedSprite(layer, 20, 20);
        const canonicalBefore = Array.from(layer._instanceData.slice(0, layer.count * layer._instanceFloatsPerSprite));
        const state = enableSprite2DYSort(layer);
        const { device, uploads } = makeUploadDevice();

        uploadSpriteInstances(device, layer, {} as GPUBuffer, -1);

        expect(uploadedTags(uploads[0]!, layer._instanceFloatsPerSprite)).toEqual([10, 20, 30]);
        expect(Array.from(state._permutation.slice(0, 3))).toEqual([low, middle, high]);
        expect(Array.from(state._inversePermutation.slice(0, 3))).toEqual([2, 0, 1]);
        expect(Array.from(layer._instanceData.slice(0, layer.count * layer._instanceFloatsPerSprite))).toEqual(canonicalBefore);
        expect([high, low, middle]).toEqual([0, 1, 2]);
    });

    it("keeps equal-Y ties in persistent insertion order across swap-remove and preserves handle identity", () => {
        const layer = createSprite2DLayer(makeMockAtlas(), { capacity: 3 });
        const removable = addSprite2D(layer, { positionPx: [300, 0], sizePx: [20, 20], color: [1, 0, 0, 1] });
        const firstTie = addSprite2D(layer, { positionPx: [100, 100], sizePx: [120, 120], color: [2, 0, 0, 1] });
        const secondTie = addSprite2D(layer, { positionPx: [100, 100], sizePx: [120, 120], color: [3, 0, 0, 1] });
        const state = enableSprite2DYSort(layer);

        removeSprite2D(removable);

        expect(getSprite2DHandleIndex(firstTie)).toBe(1);
        expect(getSprite2DHandleIndex(secondTie)).toBe(0);
        expect(pickSprite2D([layer], 100, 100)?.spriteIndex).toBe(0);
        expect(Array.from(state._permutation.slice(0, 2))).toEqual([1, 0]);
        expect(state._serials[1]).toBeLessThan(state._serials[0]!);
    });

    it("supports index and stable-handle bias setters", () => {
        const layer = createSprite2DLayer(makeMockAtlas());
        const indexSprite = addTaggedSprite(layer, 100, 1);
        const handleSprite = addSprite2D(layer, { positionPx: [100, 80], sizePx: [120, 120], color: [2, 0, 0, 1] });
        enableSprite2DYSort(layer);

        expect(pickSprite2D([layer], 100, 90)?.spriteIndex).toBe(indexSprite);
        setSprite2DYSortBias(layer, indexSprite, -50);
        expect(pickSprite2D([layer], 100, 90)?.spriteIndex).toBe(getSprite2DHandleIndex(handleSprite));
        setSprite2DYSortHandleBias(handleSprite, 100);
        expect(pickSprite2D([layer], 100, 90)?.spriteIndex).toBe(getSprite2DHandleIndex(handleSprite));
    });

    it("re-sorts Y changes but maps non-Y edits to a partial packed upload", () => {
        const layer = createSprite2DLayer(makeMockAtlas(), { capacity: 3 });
        const lastDrawn = addTaggedSprite(layer, 30, 30);
        addTaggedSprite(layer, 10, 10);
        addTaggedSprite(layer, 20, 20);
        const state = enableSprite2DYSort(layer);
        const { device, uploads } = makeUploadDevice();
        let uploadedVersion = uploadSpriteInstances(device, layer, {} as GPUBuffer, -1);

        updateSprite2DIndex(layer, lastDrawn, { color: [31, 0, 0, 1] });
        expect(state._sortDirty).toBe(false);
        uploadedVersion = uploadSpriteInstances(device, layer, {} as GPUBuffer, uploadedVersion);
        expect(uploads[1]!.offsetBytes).toBe(2 * layer._instanceStrideBytes);
        expect(uploads[1]!.data.byteLength).toBe(layer._instanceStrideBytes);
        expect(uploadedTags(uploads[1]!, layer._instanceFloatsPerSprite)).toEqual([31]);

        updateSprite2DIndex(layer, lastDrawn, { positionPx: [100, 5] });
        expect(state._sortDirty).toBe(true);
        uploadSpriteInstances(device, layer, {} as GPUBuffer, uploadedVersion);
        expect(uploads[2]!.offsetBytes).toBe(0);
        expect(uploads[2]!.data.byteLength).toBe(layer.count * layer._instanceStrideBytes);
        expect(uploadedTags(uploads[2]!, layer._instanceFloatsPerSprite)).toEqual([31, 10, 20]);
    });

    it("grows metadata with layer capacity and clear preserves the monotonic serial", () => {
        const layer = createSprite2DLayer(makeMockAtlas(), { capacity: 1 });
        addTaggedSprite(layer, 30, 1);
        const state = enableSprite2DYSort(layer, { defaultBias: 5 });
        addTaggedSprite(layer, 10, 2);
        addTaggedSprite(layer, 20, 3);
        pickSprite2D([layer], 100, 20);

        expect(state._capacity).toBe(layer._capacity);
        expect(state._permutation.length).toBe(layer._capacity);
        expect(state._packedInstances.length).toBe(layer._capacity * layer._instanceFloatsPerSprite);
        expect(Array.from(state._permutation.slice(0, 3))).toEqual([1, 2, 0]);

        const nextSerial = state._nextSerial;
        clearSprite2DLayer(layer);
        expect(state._nextSerial).toBe(nextSerial);
        expect(Array.from(state._serials.slice(0, 3))).toEqual([0, 0, 0]);
        addTaggedSprite(layer, 50, 4);
        addTaggedSprite(layer, 50, 5);
        pickSprite2D([layer], 100, 50);
        expect(Array.from(state._serials.slice(0, 2))).toEqual([nextSerial, nextSerial + 1]);
        expect(Array.from(state._permutation.slice(0, 2))).toEqual([0, 1]);
    });

    it("retains hidden sprites in ordering while picking the visible sprite beneath", () => {
        const layer = createSprite2DLayer(makeMockAtlas());
        const visible = addTaggedSprite(layer, 100, 1);
        const hidden = addTaggedSprite(layer, 100, 2, false);
        const state = enableSprite2DYSort(layer);
        setSprite2DYSortBias(layer, hidden, 100);

        expect(Array.from(state._permutation.slice(0, 2))).toEqual([0, 0]);
        expect(pickSprite2D([layer], 100, 100)?.spriteIndex).toBe(visible);
        expect(Array.from(state._permutation.slice(0, 2))).toEqual([visible, hidden]);
    });

    it("rejects unsupported depth modes and invalid options, indices, and bias values", () => {
        const depthLayer = createSprite2DLayer(makeMockAtlas(), { depth: "test" });
        expect(() => enableSprite2DYSort(depthLayer)).toThrow(/depth: "none"/);
        expect(depthLayer._ySortState).toBeUndefined();

        const layer = createSprite2DLayer(makeMockAtlas());
        addTaggedSprite(layer, 10, 1);
        expect(() => enableSprite2DYSort(layer, { defaultBias: NaN })).toThrow(/finite/);
        expect(() => setSprite2DYSortBias(layer, 0, 1)).toThrow(/not enabled/);
        enableSprite2DYSort(layer);
        expect(() => setSprite2DYSortBias(layer, 2, 1)).toThrow(/out of range/);
        expect(() => setSprite2DYSortBias(layer, 0, Infinity)).toThrow(/finite/);
        expect(() => setSprite2DYSortBias(layer, 0, -Infinity)).toThrow(/finite/);
    });

    it("keeps layer draw order authoritative while using Y-order within the top layer", () => {
        const lower = createSprite2DLayer(makeMockAtlas(), { order: 0 });
        addTaggedSprite(lower, 500, 1);
        const upper = createSprite2DLayer(makeMockAtlas(), { order: 10 });
        addTaggedSprite(upper, 90, 2);
        const upperTop = addTaggedSprite(upper, 100, 3);
        enableSprite2DYSort(upper);

        const hit = pickSprite2D([lower, upper], 100, 100);
        expect(hit?.layer).toBe(upper);
        expect(hit?.spriteIndex).toBe(upperTop);
    });

    it("rebuilds sorted staging for a recovered buffer and restores canonical upload when disabled", () => {
        const layer = createSprite2DLayer(makeMockAtlas());
        addTaggedSprite(layer, 30, 3);
        addTaggedSprite(layer, 10, 1);
        addTaggedSprite(layer, 20, 2);
        const state = enableSprite2DYSort(layer);
        const firstDevice = makeUploadDevice();
        uploadSpriteInstances(firstDevice.device, layer, {} as GPUBuffer, -1);
        const recoveredDevice = makeUploadDevice();
        const sortedVersion = uploadSpriteInstances(recoveredDevice.device, layer, {} as GPUBuffer, -1);

        expect(uploadedTags(recoveredDevice.uploads[0]!, layer._instanceFloatsPerSprite)).toEqual([1, 2, 3]);
        expect(disableSprite2DYSort(layer)).toBe(true);
        expect(state.enabled).toBe(false);
        expect(disableSprite2DYSort(layer)).toBe(false);
        const canonicalDevice = makeUploadDevice();
        uploadSpriteInstances(canonicalDevice.device, layer, {} as GPUBuffer, sortedVersion);
        expect(uploadedTags(canonicalDevice.uploads[0]!, layer._instanceFloatsPerSprite)).toEqual([3, 1, 2]);
    });

    it("keeps ordinary layer uploads canonical after the optional hook is globally registered", () => {
        const optedIn = createSprite2DLayer(makeMockAtlas());
        addTaggedSprite(optedIn, 20, 2);
        enableSprite2DYSort(optedIn);

        const ordinary = createSprite2DLayer(makeMockAtlas());
        const first = addTaggedSprite(ordinary, 20, 2);
        const second = addTaggedSprite(ordinary, 10, 1);
        const canonicalBefore = ordinary._instanceData;
        const { device, uploads } = makeUploadDevice();
        uploadSpriteInstances(device, ordinary, {} as GPUBuffer, -1);

        expect(ordinary._ySortState).toBeUndefined();
        expect(ordinary._instanceData).toBe(canonicalBefore);
        expect(uploadedTags(uploads[0]!, ordinary._instanceFloatsPerSprite)).toEqual([2, 1]);
        expect([first, second]).toEqual([0, 1]);

        removeSprite2DIndex(ordinary, first);
        expect(ordinary.count).toBe(1);
        expect(ordinary._instanceData[9]).toBe(1);
    });
});
