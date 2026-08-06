import { describe, expect, it, vi } from "vitest";

import type { GlyphCurves } from "../../../packages/babylon-lite/src/text/glyph-storage";
import { createTextData, disposeTextData, updateTextData } from "../../../packages/babylon-lite/src/text/text-data";
import { createGlyphStorage, disposeGlyphStorage, updateGlyphStorage } from "../../../packages/babylon-lite/src/text/glyph-storage";
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
function stubAtlasGpu(atlas: SharedAtlas): { curveDestroy: ReturnType<typeof vi.fn>; bandDestroy: ReturnType<typeof vi.fn> } {
    const curveDestroy = vi.fn();
    const bandDestroy = vi.fn();
    atlas.gpu = {
        device: {} as GPUDevice,
        curveTex: { destroy: curveDestroy } as unknown as GPUTexture,
        bandTex: { destroy: bandDestroy } as unknown as GPUTexture,
        curveTexRows: 1,
        bandTexRows: 1,
        uploadedVersion: 0,
    } satisfies SharedAtlasGpu;
    return { curveDestroy, bandDestroy };
}

describe("glyph storage ownership", () => {
    it("disposing a TextData does not touch its borrowed GlyphStorage's atlases", () => {
        const storage = createGlyphStorage(new Map([["f", new Map([[1, makeGlyph(1)]])]]));
        const td = createTextData(storage, [{ curveSet: "f", glyphs: [{ glyphId: 1, x: 0, y: 0 }], pixelsPerFontUnit: 1 }]);

        const atlas = storage._curveSets.get("f")!.atlas;
        const { curveDestroy, bandDestroy } = stubAtlasGpu(atlas);

        disposeTextData(td);
        // Storage outlives the TextData; the atlas is untouched.
        expect(atlas.gpu).not.toBeNull();
        expect(curveDestroy).not.toHaveBeenCalled();
        expect(bandDestroy).not.toHaveBeenCalled();

        // Only disposeGlyphStorage tears down the GPU textures.
        disposeGlyphStorage(storage);
        expect(atlas.gpu).toBeNull();
        expect(curveDestroy).toHaveBeenCalledTimes(1);
        expect(bandDestroy).toHaveBeenCalledTimes(1);
    });

    it("a single GlyphStorage can back multiple TextDatas; each TextData disposes independently", () => {
        const storage = createGlyphStorage(new Map([["f", new Map([[1, makeGlyph(1)]])]]));
        const td1 = createTextData(storage, [{ curveSet: "f", glyphs: [{ glyphId: 1, x: 0, y: 0 }], pixelsPerFontUnit: 1 }]);
        const td2 = createTextData(storage, [{ curveSet: "f", glyphs: [{ glyphId: 1, x: 0, y: 0 }], pixelsPerFontUnit: 1 }]);

        const atlas = storage._curveSets.get("f")!.atlas;
        const { curveDestroy } = stubAtlasGpu(atlas);

        disposeTextData(td1);
        expect(atlas.gpu).not.toBeNull();
        expect(curveDestroy).not.toHaveBeenCalled();

        disposeTextData(td2);
        // Still alive — storage is independent of the TextDatas that borrowed it.
        expect(atlas.gpu).not.toBeNull();
        expect(curveDestroy).not.toHaveBeenCalled();

        disposeGlyphStorage(storage);
        expect(atlas.gpu).toBeNull();
        expect(curveDestroy).toHaveBeenCalledTimes(1);
    });

    it("disposeGlyphStorage is idempotent and tears down every curveSet's atlas", () => {
        const storage = createGlyphStorage(
            new Map([
                ["en", new Map([[1, makeGlyph(1)]])],
                ["ja", new Map([[2, makeGlyph(2)]])],
            ])
        );
        const enAtlas = storage._curveSets.get("en")!.atlas;
        const jaAtlas = storage._curveSets.get("ja")!.atlas;
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
        expect(cs.curves.size).toBe(1);
        expect(cs.atlas.glyphSlots.size).toBe(1);

        const slot1Before = cs.atlas.glyphSlots.get(1);
        // Add to existing curveSet — id=1 is skipped, id=2 is appended.
        updateGlyphStorage(
            storage,
            "f",
            new Map([
                [1, makeGlyph(1)],
                [2, makeGlyph(2)],
            ])
        );
        expect(cs.curves.size).toBe(2);
        expect(cs.atlas.glyphSlots.size).toBe(2);
        expect(cs.atlas.glyphSlots.get(1)).toBe(slot1Before);

        // Create a brand-new curveSet on the same storage.
        updateGlyphStorage(storage, "g", new Map([[3, makeGlyph(3)]]));
        expect(storage._curveSets.has("g")).toBe(true);
        expect(storage._curveSets.get("g")!.curves.size).toBe(1);
        // The new curveSet has its own atlas — distinct from "f".
        expect(storage._curveSets.get("g")!.atlas).not.toBe(cs.atlas);
    });

    it("re-registering a glyph id cannot change its packed geometry (existing outline wins)", () => {
        const storage = createGlyphStorage(new Map([["f", new Map([[1, makeGlyph(1)]])]]));
        const td = createTextData(storage, [{ curveSet: "f", glyphs: [{ glyphId: 1, x: 0, y: 0 }], pixelsPerFontUnit: 1 }]);
        // Bounds + band transform occupy instance floats 0..3 and 12..15.
        const original = Array.from(td._instances.subarray(0, 16));

        // Re-registering id=1 with wildly different bounds is skipped by design. The atlas
        // band texels were already baked from the original bounds, so the geometry the packer
        // emits must keep agreeing with them — whether it reads the outline live or a snapshot.
        updateGlyphStorage(storage, "f", new Map([[1, { ...makeGlyph(1), bounds: { xMin: -500, yMin: -500, xMax: 500, yMax: 500 } }]]));
        expect(storage._curveSets.get("f")!.curves.get(1)!.bounds).toEqual({ xMin: 0, yMin: -20, xMax: 100, yMax: 100 });

        updateTextData(td, { update: "reset" });
        expect(Array.from(td._instances.subarray(0, 16))).toEqual(original);
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
        expect(td._groups[0]!.liveCount).toBe(1);
        expect(td._groups[0]!.freeSlots.length).toBe(1);

        // Compaction reset: no runs / no storage → use current.
        updateTextData(td, { update: "reset" });

        // After compaction: only the live run remains, packed contiguously, no free slots.
        expect(td._instanceCount).toBe(1);
        expect(td._groups[0]!.liveCount).toBe(1);
        expect(td._groups[0]!.freeSlots.length).toBe(0);
    });
});
