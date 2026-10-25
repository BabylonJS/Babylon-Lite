import { describe, expect, it, vi } from "vitest";
import type { SpriteAtlas } from "../../../packages/babylon-lite/src/sprite/shared/sprite-atlas";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d";
import type { Sprite2DDepthMode, Sprite2DLayer } from "../../../packages/babylon-lite/src/sprite/sprite-2d";
import {
    addSprite2DIndex,
    clearSprite2DLayer,
    createSprite2DLayer,
    removeSprite2DIndex,
    setSprite2DFrameIndex,
    updateSprite2DIndex,
} from "../../../packages/babylon-lite/src/sprite/sprite-2d";
import { addSprite2D, getSprite2DHandleIndex, removeSprite2D } from "../../../packages/babylon-lite/src/sprite/sprite-2d-handle";
import { enableSprite2DInstanceParams, setSprite2DInstanceParams, setSprite2DInstanceParamsIndex } from "../../../packages/babylon-lite/src/sprite/sprite-2d-instance-params";
import { setSprite2DUvOffset } from "../../../packages/babylon-lite/src/sprite/sprite-2d-uvscroll";
import { enableSprite2DYSort } from "../../../packages/babylon-lite/src/sprite/sprite-2d-y-sort";
import { createSprite2DCustomShader } from "../../../packages/babylon-lite/src/sprite/sprite-custom-shader";
import { uploadSpriteInstances } from "../../../packages/babylon-lite/src/sprite/sprite-pipeline";

function atlas(): SpriteAtlas {
    const texture = { texture: {} as GPUTexture, view: {} as GPUTextureView, sampler: {} as GPUSampler, width: 32, height: 32 } satisfies Texture2D;
    return {
        texture,
        textureSizePx: [32, 32],
        frames: [
            { uvMin: [0, 0], uvMax: [1, 1], sourceSizePx: [32, 32], pivot: [0.5, 0.5] },
            { uvMin: [0.5, 0], uvMax: [1, 0.5], sourceSizePx: [16, 16], pivot: [0.5, 0.5] },
        ],
        premultipliedAlpha: false,
    };
}

function customLayer(depth: Sprite2DDepthMode = "none", capacity = 2): Sprite2DLayer {
    return createSprite2DLayer(atlas(), { depth, capacity, customShader: createSprite2DCustomShader({ fragment: "return in.tint;" }) });
}

function paramsAt(layer: Sprite2DLayer, index: number): number[] {
    const base = index * layer._instanceFloatsPerSprite + layer._vertexExtension!._attribute.offset / 4;
    return Array.from(layer._instanceData.slice(base, base + 4));
}

describe("Sprite2D instance parameters", () => {
    it("rejects plain layers without changing layout, data or dirty state", () => {
        const layer = createSprite2DLayer(atlas());
        const data = layer._instanceData;
        expect(() => enableSprite2DInstanceParams(layer)).toThrow(/customShader/);
        expect(layer._instanceData).toBe(data);
        expect(layer._instanceStrideBytes).toBe(52);
        expect(layer._version).toBe(0);
        expect(Object.hasOwn(layer, "_vertexExtension")).toBe(false);
    });

    it.each(["none", "test", "test-write"] as const)("widens %s once, preserving base data and zeroing existing sprites", (depth) => {
        const layer = customLayer(depth);
        const baseStride = depth === "none" ? 13 : 14;
        for (let index = 0; index < 2; index++) {
            addSprite2DIndex(layer, { positionPx: [index * 20, 30], color: [0.25, 0.5, 0.75, 1], flipX: true, z: 0.4 });
        }
        const before = layer._instanceData.slice();
        enableSprite2DInstanceParams(layer);
        expect(layer._instanceFloatsPerSprite).toBe(baseStride + 4);
        expect(layer._instanceStrideBytes).toBe((baseStride + 4) * 4);
        expect(layer._instanceData.byteLength - before.byteLength).toBe(layer._capacity * 16);
        expect(layer._vertexExtension!._attribute).toEqual({ shaderLocation: 8, offset: baseStride * 4, format: "float32x4" });
        for (let index = 0; index < 2; index++) {
            const base = index * layer._instanceFloatsPerSprite;
            expect(layer._instanceData.slice(base, base + baseStride)).toEqual(before.slice(index * baseStride, (index + 1) * baseStride));
            expect(paramsAt(layer, index)).toEqual([0, 0, 0, 0]);
        }
        const data = layer._instanceData;
        const version = layer._version;
        enableSprite2DInstanceParams(layer);
        expect(layer._instanceData).toBe(data);
        expect(layer._version).toBe(version);
        expect([layer._dirtyMin, layer._dirtyMax]).toEqual([0, 2]);
    });

    it("enables an empty layer and initializes new sprites after capacity growth", () => {
        const layer = customLayer("none", 1);
        enableSprite2DInstanceParams(layer);
        addSprite2DIndex(layer, { positionPx: [10, 20] });
        setSprite2DInstanceParamsIndex(layer, 0, [1, 2, 3, 4]);
        addSprite2DIndex(layer, { positionPx: [30, 40] });
        expect(layer._capacity).toBe(2);
        expect(paramsAt(layer, 0)).toEqual([1, 2, 3, 4]);
        expect(paramsAt(layer, 1)).toEqual([0, 0, 0, 0]);
        expect(layer._instanceData.byteLength).toBe(2 * 68);
    });

    it("rejects a foreign extension before changing layout, data or dirty state", () => {
        const donor = customLayer();
        enableSprite2DInstanceParams(donor);
        const layer = customLayer();
        addSprite2DIndex(layer, { positionPx: [10, 20] });
        const extension = { ...donor._vertexExtension!, _owner: {} };
        layer._vertexExtension = extension;
        const data = layer._instanceData;
        const before = data.slice();
        const dirtyBefore = [layer._version, layer._dirtyMin, layer._dirtyMax];
        expect(() => enableSprite2DInstanceParams(layer)).toThrow(/another instance extension/);
        expect(() => setSprite2DInstanceParamsIndex(layer, 0, [1, 2, 3, 4])).toThrow(/called first/);
        expect(layer._vertexExtension).toBe(extension);
        expect(layer._instanceData).toBe(data);
        expect(layer._instanceData).toEqual(before);
        expect(layer._instanceStrideBytes).toBe(52);
        expect([layer._version, layer._dirtyMin, layer._dirtyMax]).toEqual(dirtyBefore);
    });

    it("copies and Float32-rounds values without changing color, UV, Z or caller storage", () => {
        const layer = customLayer("test");
        addSprite2DIndex(layer, { positionPx: [0, 0], color: [0.25, 0.5, 0.75, 1], z: 0.4 });
        enableSprite2DInstanceParams(layer);
        const baseBefore = layer._instanceData.slice(0, 14);
        const input: [number, number, number, number] = [0.1, -0.2, 3, 4];
        setSprite2DInstanceParamsIndex(layer, 0, input);
        input[0] = 99;
        expect(paramsAt(layer, 0)).toEqual([Math.fround(0.1), Math.fround(-0.2), 3, 4]);
        expect(layer._instanceData.slice(0, 14)).toEqual(baseBefore);
        const arrayInput = new Float32Array([5, 6, 7, 8]);
        setSprite2DInstanceParamsIndex(layer, 0, arrayInput);
        arrayInput.fill(0);
        expect(paramsAt(layer, 0)).toEqual([5, 6, 7, 8]);
    });

    it("preserves parameters across ordinary updates and resets reused tail slots and clear/refill", () => {
        const layer = customLayer();
        enableSprite2DInstanceParams(layer);
        addSprite2DIndex(layer, { positionPx: [10, 20] });
        addSprite2DIndex(layer, { positionPx: [30, 40] });
        setSprite2DInstanceParamsIndex(layer, 0, [1, 2, 3, 4]);
        setSprite2DInstanceParamsIndex(layer, 1, [5, 6, 7, 8]);
        updateSprite2DIndex(layer, 1, { positionPx: [50, 60], visible: false, flipY: true });
        setSprite2DFrameIndex(layer, 1, 1);
        updateSprite2DIndex(layer, 1, { visible: true });
        expect(paramsAt(layer, 1)).toEqual([5, 6, 7, 8]);
        removeSprite2DIndex(layer, 0);
        expect(paramsAt(layer, 0)).toEqual([5, 6, 7, 8]);
        addSprite2DIndex(layer, { positionPx: [70, 80] });
        expect(paramsAt(layer, 1)).toEqual([0, 0, 0, 0]);
        setSprite2DInstanceParamsIndex(layer, 1, [9, 9, 9, 9]);
        const data = layer._instanceData;
        clearSprite2DLayer(layer);
        addSprite2DIndex(layer, { positionPx: [0, 0] });
        addSprite2DIndex(layer, { positionPx: [1, 1] });
        expect(layer._instanceData).toBe(data);
        expect(paramsAt(layer, 0)).toEqual([0, 0, 0, 0]);
        expect(paramsAt(layer, 1)).toEqual([0, 0, 0, 0]);
    });

    it.each(["none", "test", "test-write"] as const)("composes both UV enable orders on %s layers", (depth) => {
        for (const uvFirst of [true, false]) {
            const layer = customLayer(depth);
            addSprite2DIndex(layer, { positionPx: [10, 20], z: 0.7 });
            if (uvFirst) {
                setSprite2DUvOffset(layer, 0, [0.25, 0.5]);
            }
            enableSprite2DInstanceParams(layer);
            setSprite2DInstanceParamsIndex(layer, 0, [1, 2, 3, 4]);
            setSprite2DUvOffset(layer, 0, [0.5, 0.75]);
            expect(layer._instanceFloatsPerSprite).toBe((depth === "none" ? 13 : 14) + 6);
            expect(paramsAt(layer, 0)).toEqual([1, 2, 3, 4]);
            const uvBase = layer._uvScrollAttr!.offset / 4;
            expect(Array.from(layer._instanceData.slice(uvBase, uvBase + 2))).toEqual([0.5, 0.75]);
            if (depth !== "none") {
                expect(layer._instanceData[13]).toBe(Math.fround(0.7));
            }
        }
    });

    it("uses the current handle index after swap-remove and rejects stale handles", () => {
        const layer = customLayer();
        enableSprite2DInstanceParams(layer);
        const first = addSprite2D(layer, { positionPx: [0, 0] });
        const last = addSprite2D(layer, { positionPx: [10, 10] });
        setSprite2DInstanceParams(last, [1, 2, 3, 4]);
        removeSprite2D(first);
        expect(getSprite2DHandleIndex(last)).toBe(0);
        setSprite2DInstanceParams(last, [5, 6, 7, 8]);
        expect(paramsAt(layer, 0)).toEqual([5, 6, 7, 8]);
        expect(() => setSprite2DInstanceParams(first, [9, 9, 9, 9])).toThrow(/removed/);
        clearSprite2DLayer(layer);
        expect(() => setSprite2DInstanceParams(last, [9, 9, 9, 9])).toThrow(/removed/);
    });

    it("rejects invalid indices, lengths and Float32 overflow atomically", () => {
        const layer = customLayer();
        addSprite2DIndex(layer, { positionPx: [0, 0] });
        expect(() => setSprite2DInstanceParamsIndex(layer, 0, [1, 2, 3, 4])).toThrow(/called first/);
        enableSprite2DInstanceParams(layer);
        setSprite2DInstanceParamsIndex(layer, 0, [1, 2, 3, 4]);
        const before = layer._instanceData.slice();
        const dirtyBefore = [layer._version, layer._dirtyMin, layer._dirtyMax];
        for (const index of [-1, 1, 0.5, NaN, Infinity]) {
            expect(() => setSprite2DInstanceParamsIndex(layer, index, [5, 6, 7, 8])).toThrow(/out of range/);
        }
        for (const length of [0, 3, 5]) {
            expect(() => setSprite2DInstanceParamsIndex(layer, 0, new Float32Array(length))).toThrow(/exactly four/);
        }
        for (const bad of [NaN, Infinity, -Infinity, Number.MAX_VALUE]) {
            for (let component = 0; component < 4; component++) {
                const values: [number, number, number, number] = [5, 6, 7, 8];
                values[component] = bad;
                expect(() => setSprite2DInstanceParamsIndex(layer, 0, values)).toThrow(/finite Float32/);
            }
        }
        expect(layer._instanceData).toEqual(before);
        expect([layer._version, layer._dirtyMin, layer._dirtyMax]).toEqual(dirtyBefore);
    });

    it("reuses staging storage and creates no typed-array views during parameter writes", () => {
        const layer = customLayer();
        enableSprite2DInstanceParams(layer);
        addSprite2DIndex(layer, { positionPx: [0, 0] });
        const data = layer._instanceData;
        const input = new Float32Array([1, 2, 3, 4]);
        const subarray = vi.spyOn(Float32Array.prototype, "subarray");
        const slice = vi.spyOn(Float32Array.prototype, "slice");
        try {
            for (let index = 0; index < 10; index++) {
                input[0] = index;
                setSprite2DInstanceParamsIndex(layer, 0, input);
            }
            expect(subarray).not.toHaveBeenCalled();
            expect(slice).not.toHaveBeenCalled();
            expect(layer._instanceData).toBe(data);
        } finally {
            subarray.mockRestore();
            slice.mockRestore();
        }
    });

    it.each([false, true])("uploads full records then one dirty draw slot, including late enable after Y-sort=%s", (sorted) => {
        const layer = customLayer();
        addSprite2DIndex(layer, { positionPx: [0, 30] });
        addSprite2DIndex(layer, { positionPx: [0, 10] });
        if (sorted) {
            enableSprite2DYSort(layer);
        }
        const writeBuffer = vi.fn();
        const device = { queue: { writeBuffer } } as unknown as GPUDevice;
        const buffer = {} as GPUBuffer;
        let version = uploadSpriteInstances(device, layer, buffer, -1);
        enableSprite2DInstanceParams(layer);
        setSprite2DInstanceParamsIndex(layer, 0, [1, 2, 3, 4]);
        setSprite2DInstanceParamsIndex(layer, 1, [5, 6, 7, 8]);
        version = uploadSpriteInstances(device, layer, buffer, version);
        expect(writeBuffer.mock.calls[1]![4]).toBe(2 * 68);
        const data = sorted ? layer._ySortState!._packedInstances : layer._instanceData;
        const offset = layer._vertexExtension!._attribute.offset / 4;
        expect(Array.from(data.slice(offset, offset + 4))).toEqual(sorted ? [5, 6, 7, 8] : [1, 2, 3, 4]);
        setSprite2DInstanceParamsIndex(layer, 0, [9, 10, 11, 12]);
        version = uploadSpriteInstances(device, layer, buffer, version);
        expect(writeBuffer.mock.calls[2]![1]).toBe(sorted ? 68 : 0);
        expect(writeBuffer.mock.calls[2]![4]).toBe(68);
        expect(uploadSpriteInstances(device, layer, buffer, version)).toBe(version);
        expect(writeBuffer).toHaveBeenCalledTimes(3);
    });
});
