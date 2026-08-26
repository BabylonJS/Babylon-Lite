import { describe, expect, it, vi } from "vitest";

import type { GlyphCurves } from "../../../packages/babylon-lite/src/text/glyph-storage";
import { createTextData, disposeTextData, updateTextData } from "../../../packages/babylon-lite/src/text/text-data";
import { createGlyphStorage, disposeGlyphStorage, GLYPH_METADATA_FLOATS, updateGlyphStorage } from "../../../packages/babylon-lite/src/text/glyph-storage";
import type { SharedAtlas, SharedAtlasGpu } from "../../../packages/babylon-lite/src/text/glyph-storage";

function makeGlyph(glyphId: number): GlyphCurves {
    return {
        glyphId,
        curves: [
            { p0x: 0, p0y: 0, p1x: 50, p1y: 100, p2x: 100, p2y: 0 },
            { p0x: 100, p0y: 0, p1x: 50, p1y: -20, p2x: 0, p2y: 0 },
        ],
        bounds: { xMin: 0, yMin: -20, xMax: 100, yMax: 100 },
    };
}

/** Install a fake GPU resource set on an atlas with spy-able destroy() calls. */
function stubAtlasGpu(atlas: SharedAtlas): { curveDestroy: ReturnType<typeof vi.fn>; bandDestroy: ReturnType<typeof vi.fn>; metaDestroy: ReturnType<typeof vi.fn> } {
    const curveDestroy = vi.fn();
    const bandDestroy = vi.fn();
    const metaDestroy = vi.fn();
    atlas._gpu = {
        _device: {} as GPUDevice,
        _curveTex: { destroy: curveDestroy } as unknown as GPUTexture,
        _bandTex: { destroy: bandDestroy } as unknown as GPUTexture,
        _curveTexRows: 1,
        _bandTexRows: 1,
        _metaBuf: { destroy: metaDestroy } as unknown as GPUBuffer,
        _metaCap: 1,
        _uploadedVersion: 0,
    } satisfies SharedAtlasGpu;
    return { curveDestroy, bandDestroy, metaDestroy };
}

describe("glyph storage ownership", () => {
    it("disposing a TextData does not touch its borrowed GlyphStorage's atlases", () => {
        const storage = createGlyphStorage(new Map([["f", new Map([[1, makeGlyph(1)]])]]));
        const td = createTextData(storage, [{ curveSet: "f", glyphs: [{ glyphId: 1, x: 0, y: 0 }], pixelsPerFontUnit: 1 }]);

        const atlas = storage._curveSets.get("f")!._atlas;
        const { curveDestroy, bandDestroy, metaDestroy } = stubAtlasGpu(atlas);

        disposeTextData(td);
        // Storage outlives the TextData; the atlas is untouched.
        expect(atlas._gpu).not.toBeNull();
        expect(curveDestroy).not.toHaveBeenCalled();
        expect(bandDestroy).not.toHaveBeenCalled();
        expect(metaDestroy).not.toHaveBeenCalled();

        // Only disposeGlyphStorage tears down the GPU textures.
        disposeGlyphStorage(storage);
        expect(atlas._gpu).toBeNull();
        expect(curveDestroy).toHaveBeenCalledTimes(1);
        expect(bandDestroy).toHaveBeenCalledTimes(1);
        expect(metaDestroy).toHaveBeenCalledTimes(1);
    });

    it("a single GlyphStorage can back multiple TextDatas; each TextData disposes independently", () => {
        const storage = createGlyphStorage(new Map([["f", new Map([[1, makeGlyph(1)]])]]));
        const td1 = createTextData(storage, [{ curveSet: "f", glyphs: [{ glyphId: 1, x: 0, y: 0 }], pixelsPerFontUnit: 1 }]);
        const td2 = createTextData(storage, [{ curveSet: "f", glyphs: [{ glyphId: 1, x: 0, y: 0 }], pixelsPerFontUnit: 1 }]);

        const atlas = storage._curveSets.get("f")!._atlas;
        const { curveDestroy } = stubAtlasGpu(atlas);

        disposeTextData(td1);
        expect(atlas._gpu).not.toBeNull();
        expect(curveDestroy).not.toHaveBeenCalled();

        disposeTextData(td2);
        // Still alive — storage is independent of the TextDatas that borrowed it.
        expect(atlas._gpu).not.toBeNull();
        expect(curveDestroy).not.toHaveBeenCalled();

        disposeGlyphStorage(storage);
        expect(atlas._gpu).toBeNull();
        expect(curveDestroy).toHaveBeenCalledTimes(1);
    });

    it("disposeGlyphStorage is idempotent and tears down every curveSet's atlas", () => {
        const storage = createGlyphStorage(
            new Map([
                ["en", new Map([[1, makeGlyph(1)]])],
                ["ja", new Map([[2, makeGlyph(2)]])],
            ])
        );
        const enAtlas = storage._curveSets.get("en")!._atlas;
        const jaAtlas = storage._curveSets.get("ja")!._atlas;
        const en = stubAtlasGpu(enAtlas);
        const ja = stubAtlasGpu(jaAtlas);

        disposeGlyphStorage(storage);
        expect(en.curveDestroy).toHaveBeenCalledTimes(1);
        expect(ja.curveDestroy).toHaveBeenCalledTimes(1);
        expect(storage._curveSets.size).toBe(0);

        // Second call is a no-op.
        disposeGlyphStorage(storage);
        expect(en.curveDestroy).toHaveBeenCalledTimes(1);
        expect(ja.curveDestroy).toHaveBeenCalledTimes(1);
    });

    it("updateGlyphStorage extends an existing curveSet and creates new ones on demand", () => {
        const storage = createGlyphStorage(new Map([["f", new Map([[1, makeGlyph(1)]])]]));
        const cs = storage._curveSets.get("f")!;
        expect(cs._curves.size).toBe(1);
        expect(cs._atlas._glyphSlots.size).toBe(1);

        const slot1Before = cs._atlas._glyphSlots.get(1);
        // Add to existing curveSet — id=1 is skipped, id=2 is appended.
        updateGlyphStorage(
            storage,
            "f",
            new Map([
                [1, makeGlyph(1)],
                [2, makeGlyph(2)],
            ])
        );
        expect(cs._curves.size).toBe(2);
        expect(cs._atlas._glyphSlots.size).toBe(2);
        expect(cs._atlas._glyphSlots.get(1)).toBe(slot1Before);

        // Create a brand-new curveSet on the same storage.
        updateGlyphStorage(storage, "g", new Map([[3, makeGlyph(3)]]));
        expect(storage._curveSets.has("g")).toBe(true);
        expect(storage._curveSets.get("g")!._curves.size).toBe(1);
        // The new curveSet has its own atlas — distinct from "f".
        expect(storage._curveSets.get("g")!._atlas).not.toBe(cs._atlas);
    });

    it("re-registering a glyph id cannot change its packed geometry (existing outline wins)", () => {
        const storage = createGlyphStorage(new Map([["f", new Map([[1, makeGlyph(1)]])]]));
        const td = createTextData(storage, [{ curveSet: "f", glyphs: [{ glyphId: 1, x: 0, y: 0 }], pixelsPerFontUnit: 1 }]);
        // Bounds, atlas location and band transform live in the atlas's glyph metadata table,
        // one `GLYPH_METADATA_FLOATS` entry per slot, and are what the vertex shader reads.
        const atlas = storage._curveSets.get("f")!._atlas;
        const original = Array.from(atlas._metaData.subarray(0, GLYPH_METADATA_FLOATS));

        // Re-registering id=1 with wildly different bounds is skipped by design. The atlas
        // band texels were already baked from the original bounds, so the geometry the packer
        // emits must keep agreeing with them — whether it reads the outline live or a snapshot.
        updateGlyphStorage(storage, "f", new Map([[1, { ...makeGlyph(1), bounds: { xMin: -500, yMin: -500, xMax: 500, yMax: 500 } }]]));
        expect(storage._curveSets.get("f")!._curves.get(1)!.bounds).toEqual({ xMin: 0, yMin: -20, xMax: 100, yMax: 100 });

        updateTextData(td, { update: "reset" });
        expect(Array.from(atlas._metaData.subarray(0, GLYPH_METADATA_FLOATS))).toEqual(original);
    });

    it("reset compaction (no runs, no storage) re-lays-out slots and frees dead-slot gaps", () => {
        const storage = createGlyphStorage(
            new Map([
                [
                    "f",
                    new Map([
                        [1, makeGlyph(1)],
                        [2, makeGlyph(2)],
                    ]),
                ],
            ])
        );
        const r1 = { curveSet: "f", glyphs: [{ glyphId: 1, x: 0, y: 0 }], pixelsPerFontUnit: 1 };
        const r2 = { curveSet: "f", glyphs: [{ glyphId: 2, x: 0, y: 0 }], pixelsPerFontUnit: 1 };
        const td = createTextData(storage, [r1, r2]);

        // Remove the first run → leaves a dead-slot gap inside the group's range.
        // (group.liveCount stays > 0 because r2 is still alive, so no dropEmptyGroup.)
        updateTextData(td, { update: "removeRun", run: r1 });

        // group has 2 slots reserved but only 1 live (the freed slot is dead-sentinel).
        expect(td._instanceCount).toBe(2);
        expect(td._groups[0]!._liveCount).toBe(1);
        expect(td._groups[0]!._freeSlots.length).toBe(1);

        // Compaction reset: no runs / no storage → use current.
        updateTextData(td, { update: "reset" });

        // After compaction: only the live run remains, packed contiguously, no free slots.
        expect(td._instanceCount).toBe(1);
        expect(td._groups[0]!._liveCount).toBe(1);
        expect(td._groups[0]!._freeSlots.length).toBe(0);
    });
});
