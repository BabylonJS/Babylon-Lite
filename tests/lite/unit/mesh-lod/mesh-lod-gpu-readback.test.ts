/** MeshLoD GPU demand-readback decode tests (Task 7 — architecture §12.3 step 8).
 *
 *  `decodeMeshLoDGpuReadback` is the pure translation of a copied selection control
 *  buffer into streaming page demand + per-frame diagnostics. The per-page words hold
 *  accumulated benefit (pageShare × 256); dividing by a page's stored bytes reproduces
 *  the CPU oracle's benefit/cost priority (§11.1). The real WGSL fills the control buffer
 *  and the full streaming loop is browser-validated; here we pin the decode math. */

import { describe, expect, it } from "vitest";
import {
    CONTROL_COUNT_WORD,
    CONTROL_FALLBACK_WORD,
    CONTROL_OVERFLOW_WORD,
    CONTROL_PAGE_DEMAND_OFFSET,
    CONTROL_SELECTED_ERROR_WORD,
    CONTROL_TRIANGLE_WORD,
    CONTROL_UNMET_ERROR_WORD,
    CONTROL_VISIBLE_GROUP_WORD,
    decodeMeshLoDGpuReadback,
    meshLoDPageDemandBitsOffset,
} from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-selection-gpu.js";

const FIXED_SCALE = 256;

/** Build a control buffer for `pageCount` pages, then set diagnostics + per-page benefit. */
function control(pageCount: number, diag: Partial<Record<"count" | "visible" | "triangles" | "overflow" | "fallback", number>>, benefit: Record<number, number>): Uint32Array {
    const demandBitsOffset = meshLoDPageDemandBitsOffset(pageCount);
    const words = new Uint32Array(demandBitsOffset + Math.ceil(pageCount / 32));
    words[CONTROL_COUNT_WORD] = diag.count ?? 0;
    words[CONTROL_VISIBLE_GROUP_WORD] = diag.visible ?? 0;
    words[CONTROL_TRIANGLE_WORD] = diag.triangles ?? 0;
    words[CONTROL_OVERFLOW_WORD] = diag.overflow ?? 0;
    words[CONTROL_FALLBACK_WORD] = diag.fallback ?? 0;
    for (const [pageId, value] of Object.entries(benefit)) {
        const id = Number(pageId);
        words[CONTROL_PAGE_DEMAND_OFFSET + id] = value;
        words[demandBitsOffset + (id >>> 5)]! |= 1 << (id & 31);
    }
    return words;
}

describe("decodeMeshLoDGpuReadback", () => {
    it("decodes per-page demand as benefit / scale / stored bytes", () => {
        // Page 2 benefit 256 (=1.0 after /scale), stored 4 → priority 0.25.
        // Page 5 benefit 512 (=2.0), stored 8 → priority 0.25 as well.
        const stored = [1, 1, 4, 1, 1, 8];
        const decoded = decodeMeshLoDGpuReadback(control(6, {}, { 2: 1 * FIXED_SCALE, 5: 2 * FIXED_SCALE }), 6, (p) => stored[p]!);
        expect(decoded.demand).toHaveLength(2);
        const byId = new Map(decoded.demand.map((d) => [d.pageId, d.priority]));
        expect(byId.get(2)).toBeCloseTo(0.25, 6);
        expect(byId.get(5)).toBeCloseTo(0.25, 6);
    });

    it("omits undemanded pages and reports an empty demand list", () => {
        const decoded = decodeMeshLoDGpuReadback(control(4, {}, {}), 4, () => 1);
        expect(decoded.demand).toEqual([]);
    });

    it("preserves demanded pages with zero priority across bitset word boundaries", () => {
        const decoded = decodeMeshLoDGpuReadback(control(70, {}, { 0: 0, 31: 0, 32: 0, 63: 0, 69: 0 }), 70, () => 65536);
        expect(decoded.demand).toEqual([0, 31, 32, 63, 69].map((pageId) => ({ pageId, priority: 0 })));
    });

    it("sorts demand by descending priority then ascending page id", () => {
        // Equal stored bytes → priority ∝ benefit. Page 1 and 3 tie (benefit 512); page 2 higher (1024).
        const decoded = decodeMeshLoDGpuReadback(control(4, {}, { 1: 512, 2: 1024, 3: 512 }), 4, () => 1);
        expect(decoded.demand.map((d) => d.pageId)).toEqual([2, 1, 3]);
    });

    it("reads back the diagnostics counters and overflow flag", () => {
        const data = control(2, { count: 7, visible: 12, triangles: 4900, overflow: 1, fallback: 3 }, {});
        data[CONTROL_SELECTED_ERROR_WORD] = new Uint32Array(new Float32Array([3.25]).buffer)[0]!;
        data[CONTROL_UNMET_ERROR_WORD] = new Uint32Array(new Float32Array([8.5]).buffer)[0]!;
        const decoded = decodeMeshLoDGpuReadback(data, 2, () => 1);
        expect(decoded.selectedClusterCount).toBe(7);
        expect(decoded.visibleGroupCount).toBe(12);
        expect(decoded.renderedTriangleCount).toBe(4900);
        expect(decoded.fallbackGroupCount).toBe(3);
        expect(decoded.maximumSelectedErrorPixels).toBe(3.25);
        expect(decoded.maximumUnmetErrorPixels).toBe(8.5);
        expect(decoded.overflow).toBe(true);
    });

    it("treats a zero stored-bytes accessor result as 1 (no divide by zero)", () => {
        const decoded = decodeMeshLoDGpuReadback(control(1, {}, { 0: FIXED_SCALE }), 1, () => 0);
        expect(decoded.demand[0]!.priority).toBeCloseTo(1, 6);
    });
});
