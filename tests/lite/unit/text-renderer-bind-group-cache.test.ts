/**
 * Text renderer per-draw-group bind-group cache.
 *
 * `LayerGpu.bindGroups` is keyed by draw-group *index*, but `TextData._groups` is not
 * index-stable: `applyReset` rebuilds it in curve-set-first-seen order (reusing the group
 * objects), and `dropEmptyGroup` splices. A cache entry must therefore be invalidated when
 * the group at that index switches to a different curve set — otherwise a run draws while
 * sampling another curve set's atlas textures, which renders correctly-positioned but
 * wrong-shaped glyphs.
 *
 * The atlas-version guard alone cannot catch this: every curve set owns its own
 * `SharedAtlas` (see `makeCurveSet`), and those independent version counters routinely
 * hold the same integer, so a reorder produces no version change. These tests assert on
 * the actual textures bound per group rather than on version numbers.
 *
 * Pure CPU — the GPU device is mocked. Real text draws are covered by the parity scenes.
 */
import { describe, expect, it, vi } from "vitest";

import type { GlyphCurves } from "../../../packages/babylon-lite/src/text/glyph-storage";
import { createGlyphStorage } from "../../../packages/babylon-lite/src/text/glyph-storage";
import type { GlyphRun } from "../../../packages/babylon-lite/src/text/text-data";
import { createTextData, updateTextData } from "../../../packages/babylon-lite/src/text/text-data";
import type { TextLayer, TextRenderer } from "../../../packages/babylon-lite/src/text/text-renderer";
import { createTextLayer, createTextRenderer } from "../../../packages/babylon-lite/src/text/text-renderer";
import type { SurfaceContext } from "../../../packages/babylon-lite/src/engine/surface";

// ── Mock GPU device ───────────────────────────────────────────────
// Only the calls the text renderer makes during `_update()` are implemented. Textures and
// their views carry a back-reference so a bind group can be traced to the atlas it samples.

type MockTexture = { label: string; __id: number; createView: () => MockTextureView; destroy: () => void };
type MockTextureView = { __texture: MockTexture };
type MockBindGroup = { label: string; __entries: { binding: number; resource: unknown }[] };

function createMockDevice() {
    let nextTextureId = 0;
    const counters = { bindGroupsCreated: 0, texturesCreated: 0 };

    const device = {
        createBuffer: vi.fn((desc: { label?: string; size: number }) => ({
            label: desc.label ?? "",
            getMappedRange: () => new ArrayBuffer(desc.size),
            unmap: vi.fn(),
            destroy: vi.fn(),
        })),
        createTexture: vi.fn((desc: { label?: string }): MockTexture => {
            counters.texturesCreated++;
            const tex: MockTexture = {
                label: desc.label ?? "",
                __id: nextTextureId++,
                createView: () => ({ __texture: tex }),
                destroy: vi.fn(),
            };
            return tex;
        }),
        createBindGroup: vi.fn((desc: { label?: string; entries: { binding: number; resource: unknown }[] }): MockBindGroup => {
            counters.bindGroupsCreated++;
            return { label: desc.label ?? "", __entries: desc.entries };
        }),
        createBindGroupLayout: vi.fn(() => ({})),
        createPipelineLayout: vi.fn(() => ({})),
        createShaderModule: vi.fn(() => ({})),
        createRenderPipeline: vi.fn(() => ({})),
        queue: { writeBuffer: vi.fn(), writeTexture: vi.fn() },
    };

    return { device, counters };
}

/** A surface backed by the mock device. Each call builds a fresh device so the text
 *  pipeline cache (keyed by device) does not leak between tests. */
function createMockSurface() {
    const { device, counters } = createMockDevice();
    const engine = { _device: device };
    const surface = {
        engine,
        canvas: { width: 800, height: 600 },
        format: "bgra8unorm",
    } as unknown as SurfaceContext;
    return { surface, counters };
}

// ── Text fixtures ─────────────────────────────────────────────────

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

/** Two curve sets, each with its own `SharedAtlas`. */
function makeStorage() {
    const curves = (ids: number[]) => new Map<number, GlyphCurves>(ids.map((id) => [id, makeGlyph(id)]));
    return createGlyphStorage(
        new Map([
            ["f", curves([1, 2, 3])],
            ["g", curves([1, 2, 3])],
        ])
    );
}

function run(curveSet: string, x: number, glyphIds: number[] = [1, 2]): GlyphRun {
    return {
        curveSet,
        glyphs: glyphIds.map((glyphId, i) => ({ glyphId, x: x + i, y: 0 })),
        pixelsPerFontUnit: 1,
    };
}

// ── Assertions ────────────────────────────────────────────────────

function layerGpu(rr: TextRenderer, layer: TextLayer) {
    const lg = rr._layerGpu.get(layer);
    expect(lg).toBeDefined();
    return lg!;
}

/** Every cached bind group must sample the atlas of the group that now sits at its index. */
function expectBindGroupsMatchGroups(rr: TextRenderer, layer: TextLayer): void {
    const lg = layerGpu(rr, layer);
    const groups = layer.data._groups;

    // The three per-group arrays are parallel: same length, written and truncated together.
    expect(lg.bindGroups.length).toBe(groups.length);
    expect(lg.bindGroupAtlasVersions.length).toBe(groups.length);
    expect(lg.bindGroupCurveSetIds.length).toBe(groups.length);

    for (let i = 0; i < groups.length; i++) {
        const g = groups[i]!;
        const gpu = g.curveSet.atlas.gpu;
        expect(gpu).not.toBeNull();

        const bg = lg.bindGroups[i] as unknown as MockBindGroup;
        const curveView = bg.__entries.find((e) => e.binding === 1)!.resource as MockTextureView;
        const bandView = bg.__entries.find((e) => e.binding === 2)!.resource as MockTextureView;

        expect(curveView.__texture).toBe(gpu!.curveTex);
        expect(bandView.__texture).toBe(gpu!.bandTex);
        expect(lg.bindGroupCurveSetIds[i]).toBe(g.curveSetId);
    }
}

describe("text renderer bind-group cache", () => {
    it("rebinds the correct atlas after a reset reorders draw groups", () => {
        const { surface } = createMockSurface();
        const storage = makeStorage();
        const data = createTextData(storage, [run("f", 0), run("g", 10)]);
        const layer = createTextLayer(data);
        const rr = createTextRenderer(surface, { layers: [layer] });

        rr._update();

        expect(data._groups.map((g) => g.curveSetId)).toEqual(["f", "g"]);
        expectBindGroupsMatchGroups(rr, layer);

        const atlasF = storage._curveSets.get("f")!.atlas;
        const atlasG = storage._curveSets.get("g")!.atlas;
        // Independent atlases whose version counters collide — the reason an atlas-version
        // check alone cannot detect the reorder below.
        expect(atlasF.gpu!.uploadedVersion).toBe(atlasG.gpu!.uploadedVersion);
        expect(atlasF.gpu!.curveTex).not.toBe(atlasG.gpu!.curveTex);

        // Same curve sets, same group count, reversed order → `applyReset` swaps the two
        // group objects in `_groups` without changing its length.
        updateTextData(data, { update: "reset", runs: [run("g", 10), run("f", 0)] });
        expect(data._groups.map((g) => g.curveSetId)).toEqual(["g", "f"]);

        rr._update();

        expectBindGroupsMatchGroups(rr, layer);
    });

    it("does not recreate bind groups when nothing changed", () => {
        const { surface, counters } = createMockSurface();
        const storage = makeStorage();
        const data = createTextData(storage, [run("f", 0), run("g", 10)]);
        const layer = createTextLayer(data);
        const rr = createTextRenderer(surface, { layers: [layer] });

        rr._update();
        const afterFirst = counters.bindGroupsCreated;
        expect(afterFirst).toBe(2);

        rr._update();
        rr._update();

        expect(counters.bindGroupsCreated).toBe(afterFirst);
        expectBindGroupsMatchGroups(rr, layer);
    });

    it("truncates the per-group cache when a curve set disappears", () => {
        const { surface } = createMockSurface();
        const storage = makeStorage();
        const data = createTextData(storage, [run("f", 0), run("g", 10)]);
        const layer = createTextLayer(data);
        const rr = createTextRenderer(surface, { layers: [layer] });

        rr._update();
        expect(layerGpu(rr, layer).bindGroups.length).toBe(2);

        updateTextData(data, { update: "reset", runs: [run("g", 10)] });
        rr._update();

        expect(data._groups.map((g) => g.curveSetId)).toEqual(["g"]);
        expectBindGroupsMatchGroups(rr, layer);
    });
});
