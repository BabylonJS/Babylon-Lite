import { describe, expect, it } from "vitest";

import type { GLGlyphCurves } from "../../../packages/babylon-lite-gl/src/text/glyph-storage";
import { createGlyphStorage } from "../../../packages/babylon-lite-gl/src/text/glyph-storage";
import type { GLGlyphRun } from "../../../packages/babylon-lite-gl/src/text/text-data";
import { createTextData, updateTextData } from "../../../packages/babylon-lite-gl/src/text/text-data";
import { createGLEngine } from "../../../packages/babylon-lite-gl/src/context";
import { ensureTextDataGpu } from "../../../packages/babylon-lite-gl/src/text/_gpu/text-instances";
import { createMockCanvas, createMockGL } from "./_lite-gl-mock";

function makeGlyph(glyphId: number): GLGlyphCurves {
    return {
        glyphId,
        curves: [
            { p0x: 0, p0y: 0, p1x: 50, p1y: 100, p2x: 100, p2y: 0 },
            { p0x: 100, p0y: 0, p1x: 50, p1y: -20, p2x: 0, p2y: 0 },
        ],
        bounds: { xMin: 0, yMin: -20, xMax: 100, yMax: 100 },
    };
}

function makeStorage() {
    return createGlyphStorage(
        new Map([
            ["f", new Map([[1, makeGlyph(1)]])],
            ["g", new Map([[1, makeGlyph(1)]])],
        ])
    );
}

function run(curveSet: string, glyphIds: number[]): GLGlyphRun {
    return { curveSet, glyphs: glyphIds.map((glyphId, i) => ({ glyphId, x: i, y: 0 })), pixelsPerFontUnit: 1 };
}

describe("lite-gl text data: groups referenced by empty runs", () => {
    it.each([false, true])("GPU capacity tracking does not depend on retained restoration data (opt-out=%s)", (doNotHandleContextLost) => {
        const mock = createMockGL();
        const engine = createGLEngine(createMockCanvas(mock), { doNotHandleContextLost });
        const data = createTextData(makeStorage(), [run("f", [1])]);
        const gpu = ensureTextDataGpu(engine, data);
        const buffer = gpu._instanceBuf;
        mock.clear();
        ensureTextDataGpu(engine, data);
        expect(mock.log).toEqual([]);
        expect(gpu._instanceBuf).toBe(buffer);
        updateTextData(data, { update: "addRun", run: run("f", new Array<number>(100).fill(1)) });
        mock.clear();
        ensureTextDataGpu(engine, data);
        expect(mock.count("createBuffer")).toBe(1);
        expect(mock.count("deleteBuffer")).toBe(1);
        expect(gpu._instanceBuf).not.toBe(buffer);
        expect(gpu._instanceBuf.byteLength).toBe(data._instances.byteLength);
    });

    it("keeps a group alive while an empty run still references it, then retires it with the last run", () => {
        const empty = run("f", []);
        const drawable = run("f", [1]);
        const other = run("g", [1]);
        const data = createTextData(makeStorage(), [empty, drawable, other]);

        updateTextData(data, { update: "removeRun", run: drawable });

        // The "f" group has no live instances but the empty run's record still points at it.
        expect(data._groups.map((g) => g._curveSetId)).toEqual(["f", "g"]);
        expect(data._groups[data._runRecords.get(empty)!._groupIdx]!._curveSetId).toBe("f");
        expect(data._groups[data._runRecords.get(other)!._groupIdx]!._curveSetId).toBe("g");

        // Removing the empty run afterwards must act on its own group, not on "g".
        updateTextData(data, { update: "removeRun", run: empty });

        expect(data._groups.map((g) => g._curveSetId)).toEqual(["g"]);
        expect(data._runRecords.get(other)!._groupIdx).toBe(0);
        expect(data._instanceCount).toBe(1);
    });

    it("replaces an empty run whose group lost its drawable runs", () => {
        const empty = run("f", []);
        const drawable = run("f", [1]);
        const data = createTextData(makeStorage(), [empty, drawable, run("g", [1])]);
        updateTextData(data, { update: "removeRun", run: drawable });

        const filled = run("f", [1]);
        updateTextData(data, { update: "replaceRun", previous: empty, run: filled });

        expect(data._groups.map((g) => g._curveSetId)).toEqual(["f", "g"]);
        expect(data._groups[data._runRecords.get(filled)!._groupIdx]!._curveSetId).toBe("f");
        expect(data._groups[0]!._liveCount).toBe(1);
        expect(data._instanceCount).toBe(2);
    });

    it("still retires a group once its last referencing run is removed", () => {
        const only = run("f", [1]);
        const data = createTextData(makeStorage(), [only, run("g", [1])]);

        updateTextData(data, { update: "removeRun", run: only });

        expect(data._groups.map((g) => g._curveSetId)).toEqual(["g"]);
        expect(data._instanceCount).toBe(1);
    });
});
