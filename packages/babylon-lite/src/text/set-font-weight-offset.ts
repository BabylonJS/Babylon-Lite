/** Synthetic font-weight offset — opt-in entry point.
 *
 *  Importing this module is what pays for the feature: it is the only module that reaches
 *  `weight-shader-fragment.ts`, so a consumer that never imports `setFontWeightOffset`
 *  carries none of the distance-to-quadratic WGSL, and its text draws keep using the base
 *  Slug pipeline with zero extra fragment-shader work.
 *
 *  This module owns *all* of the feature's semantics and state: the per-run offsets, the
 *  interned draw-group keys, the composed+compiled shader variant per `GPUDevice`, and the
 *  clamp/validation policy. `text-data.ts` and `text-pipeline.ts` only see a neutral seam.
 *
 *  The offset is in font design units (the same space as `GlyphCurves.bounds`).
 *  Positive values make the glyph bolder. */

import { TEX_WIDTH } from "./glyph-storage.js";
import type { CurveSetId, QuadCurve, SharedAtlas } from "./glyph-storage.js";
import type { GlyphRun, TextData, TextGroupKey } from "./text-data.js";
import { _installTextStyleSeam, _resolveRunRef, updateTextData } from "./text-data.js";
import type { TextPipelineVariant } from "./_gpu/text-pipeline.js";
import { _installTextVariantResolver } from "./_gpu/text-pipeline.js";
import { composeSlugShader } from "./shaders/slug-shader.js";
import { WEIGHT_SHADER_FRAGMENT } from "./shaders/weight-shader-fragment.js";

/** Maximum weight offset in font design units. Values outside 0–100 are clamped. */
const MAX_WEIGHT_OFFSET = 100;
const MITER_LIMIT = 2.5;

// Lazy-init caches: no module-level allocation (GUIDANCE §4).
let _offsets: WeakMap<GlyphRun, number> | null = null;
/** Interned per-curve-set draw-group keys for weighted runs. Objects, so a key can never
 *  `===` a `CurveSetId` string — a curve set whose id looks like another group's variant key
 *  cannot collide, which a delimited composite string key could not guarantee. */
let _keys: Map<CurveSetId, object> | null = null;
/** Composed + compiled module pair per device. A `WeakMap` keyed by `GPUDevice` both scopes
 *  the modules to their device and auto-invalidates on device change. */
let _variants: WeakMap<GPUDevice, TextPipelineVariant> | null = null;
/** Glyph ids whose otherwise-unused curve-texel channels hold miter metadata, per atlas. */
let _preparedMiters: WeakMap<SharedAtlas, Set<number>> | null = null;
let _installed = false;

function endpointsMeet(current: QuadCurve, next: QuadCurve): boolean {
    return Math.abs(current.p2x - next.p0x) < 1e-4 && Math.abs(current.p2y - next.p0y) < 1e-4;
}

/** Sign of the exact quadratic-contour area integral. Holes subtract from outer contours. */
function glyphWinding(curves: readonly QuadCurve[]): number {
    let area = 0;
    for (const curve of curves) {
        const p0p1 = curve.p0x * curve.p1y - curve.p0y * curve.p1x;
        const p1p2 = curve.p1x * curve.p2y - curve.p1y * curve.p2x;
        const p0p2 = curve.p0x * curve.p2y - curve.p0y * curve.p2x;
        area += 2 * (p0p1 + p1p2) + p0p2;
    }
    return Math.sign(area);
}

/** Write the dimensionless exterior miter vector for one convex joined endpoint. */
function writeMiter(out: Float32Array, offset: number, current: QuadCurve, next: QuadCurve | null, winding: number): boolean {
    if (!next || winding === 0) {
        return false;
    }

    let inX = current.p2x - current.p1x;
    let inY = current.p2y - current.p1y;
    let inLength = Math.hypot(inX, inY);
    if (inLength < 1e-6) {
        inX = current.p2x - current.p0x;
        inY = current.p2y - current.p0y;
        inLength = Math.hypot(inX, inY);
    }
    let outX = next.p1x - next.p0x;
    let outY = next.p1y - next.p0y;
    let outLength = Math.hypot(outX, outY);
    if (outLength < 1e-6) {
        outX = next.p2x - next.p0x;
        outY = next.p2y - next.p0y;
        outLength = Math.hypot(outX, outY);
    }
    if (inLength < 1e-6 || outLength < 1e-6) {
        return false;
    }
    inX /= inLength;
    inY /= inLength;
    outX /= outLength;
    outY /= outLength;

    // Only turns matching the glyph's winding are convex on the empty exterior side.
    const turn = inX * outY - inY * outX;
    if (Math.abs(turn) < 1e-4 || Math.sign(turn) !== winding) {
        return false;
    }

    const inNormalX = -inY;
    const inNormalY = inX;
    const normalSumX = inNormalX - outY;
    const normalSumY = inNormalY + outX;
    const sumLength = Math.hypot(normalSumX, normalSumY);
    if (sumLength < 1e-6) {
        return false;
    }
    const bisectorX = normalSumX / sumLength;
    const bisectorY = normalSumY / sumLength;
    const projection = bisectorX * inNormalX + bisectorY * inNormalY;
    if (projection < 1e-6) {
        return false;
    }
    const miterX = bisectorX / projection;
    const miterY = bisectorY / projection;
    if (miterX * miterX + miterY * miterY > MITER_LIMIT * MITER_LIMIT + 1e-6) {
        return false;
    }
    out[offset] = -winding * miterX;
    out[offset + 1] = -winding * miterY;
    return true;
}

/** Lazily patch miter vectors for the glyphs this run actually references. */
function prepareRunMiters(data: TextData, run: GlyphRun): void {
    const curveSet = data._storage._curveSets.get(run.curveSet);
    if (!curveSet) {
        return;
    }
    const atlas = curveSet._atlas;
    const preparedMiters = (_preparedMiters ??= new WeakMap());
    let prepared = preparedMiters.get(atlas);
    if (!prepared) {
        prepared = new Set();
        preparedMiters.set(atlas, prepared);
    }
    const requested = new Set<number>();
    for (const glyph of run.glyphs) {
        if (!prepared.has(glyph.glyphId)) {
            requested.add(glyph.glyphId);
        }
    }
    if (requested.size === 0) {
        return;
    }

    let curveTexel = 0;
    let changed = false;
    for (const [glyphId, glyph] of curveSet._curves) {
        const shouldPrepare = requested.has(glyphId);
        const winding = shouldPrepare ? glyphWinding(glyph.curves) : 0;
        let contourStart = 0;
        for (let i = 0; i < glyph.curves.length; i++) {
            const row0 = (curveTexel / TEX_WIDTH) | 0;
            const row1 = ((curveTexel + 1) / TEX_WIDTH) | 0;
            if (row0 !== row1) {
                curveTexel = row1 * TEX_WIDTH;
            }
            if (shouldPrepare) {
                const current = glyph.curves[i]!;
                const sequential = glyph.curves[i + 1];
                let next: QuadCurve | null = null;
                if (sequential && endpointsMeet(current, sequential)) {
                    next = sequential;
                } else {
                    const first = glyph.curves[contourStart];
                    if (first && endpointsMeet(current, first)) {
                        next = first;
                    }
                    contourStart = i + 1;
                }
                changed = writeMiter(atlas._curveTexData, (curveTexel + 1) * 4 + 2, current, next, winding) || changed;
            }
            curveTexel += 2;
        }
        if (shouldPrepare) {
            prepared.add(glyphId);
            requested.delete(glyphId);
            if (requested.size === 0) {
                break;
            }
        }
    }
    if (changed) {
        atlas._version++;
    }
}

function prepareWeightedRunMiters(data: TextData, run: GlyphRun): void {
    if (runOffset(run) > 0) {
        prepareRunMiters(data, run);
    }
}

/** Style parameter for a run: its weight offset, or 0. Packed into `TextStyle.params.y`.
 *  Reads through the nullable map rather than creating it, so a query — including the
 *  setter's own no-op check — allocates nothing. */
function runOffset(run: GlyphRun): number {
    return _offsets?.get(run) ?? 0;
}

/** Draw-group key: the run's own curve set when unweighted (so unweighted text groups and
 *  batches exactly as it did before the feature existed), the interned token otherwise. */
function runGroupKey(run: GlyphRun): TextGroupKey {
    if (runOffset(run) === 0) {
        return run.curveSet;
    }
    const keys = (_keys ??= new Map());
    let key = keys.get(run.curveSet);
    if (!key) {
        key = { _curveSetId: run.curveSet };
        keys.set(run.curveSet, key);
    }
    return key;
}

/** Compose and compile the weighted Slug shader for a device, once. The base template is
 *  shared — this adds only the fragment's incremental WGSL. */
function variantForDevice(device: GPUDevice): TextPipelineVariant {
    const variants = (_variants ??= new WeakMap());
    let variant = variants.get(device);
    if (!variant) {
        const composed = composeSlugShader(WEIGHT_SHADER_FRAGMENT);
        variant = {
            _id: composed._key,
            _vertModule: device.createShaderModule({ label: "text-vert-" + composed._key, code: composed._vert }),
            _fragModule: device.createShaderModule({ label: "text-frag-" + composed._key, code: composed._frag }),
        };
        variants.set(device, variant);
    }
    return variant;
}

function ensureInstalled(): void {
    if (_installed) {
        return;
    }
    _installed = true;
    // Feed text-data's neutral styling seam: one float packed into TextStyle.params.y, and
    // one opaque draw-group key. text-data attaches no meaning to either.
    _installTextStyleSeam({ _prepare: prepareWeightedRunMiters, _key: runGroupKey, _param: runOffset });
    // Supply the compiled module pair that variant draw groups render with.
    _installTextVariantResolver(variantForDevice);
}

/** Set the synthetic font-weight contour offset (in font design units) of one run of `data`.
 *
 *  This mutates live text data, like a setter on a material: the run is repacked and
 *  regrouped before the call returns, so it is valid at any point in the `TextData`'s life —
 *  including after it is already bound and rendering. Runs are packed synchronously by
 *  `createTextData` / `createDefaultTextData` / `updateTextData`, which is why the offset
 *  belongs to the owning data rather than to a detached run descriptor.
 *
 *  - Positive offsets expand the rendered fill outward (bolder / thicker).
 *  - Zero removes any previously set offset, returning the run to the base pipeline.
 *
 *  Offsets are keyed by run identity, so an update that *replaces* a run descriptor (e.g.
 *  `updateDefaultTextData`, or `updateTextData({ update: "replaceRun" })`) drops the offset;
 *  re-apply it to the new run — by index, most conveniently.
 *
 *  @param data - The `TextData` (or `DefaultTextData`) that owns the run.
 *  @param run - The run to weight: its `GlyphRun` reference, or its index in `data.runs`.
 *  @param offset - Contour offset in font design units. Finite, clamped to 0–100. */
export function setFontWeightOffset(data: TextData, run: GlyphRun | number, offset: number): void {
    // Validate and resolve *before* installing anything: a rejected call, a call naming a
    // run this data does not own, and a redundant call must not compile a shader variant or
    // install seams that every subsequent pack would then have to consult.
    if (!Number.isFinite(offset)) {
        console.error("setFontWeightOffset: offset must be finite, got", offset);
        return;
    }
    const target = _resolveRunRef(data, run, "setFontWeightOffset");
    const clamped = Math.min(Math.max(offset, 0), MAX_WEIGHT_OFFSET);
    if (clamped !== offset) {
        console.warn(`setFontWeightOffset: offset ${offset} clamped to ${clamped} (range 0–${MAX_WEIGHT_OFFSET} font units).`);
    }
    if (clamped > 0) {
        prepareRunMiters(data, target);
    }
    if (runOffset(target) === clamped) {
        // Nothing would change. Notably, clearing a run that was never weighted leaves the
        // feature completely uninstalled, so such a consumer keeps the base pipeline.
        return;
    }
    // Capture the map's exact prior shape for this run — not just its observed value — so a
    // failed reset below can be rolled back precisely. A 0 entry is never actually stored (see
    // the delete branch), so "had no entry" and "had an entry worth 0" cannot both occur today,
    // but capturing presence rather than inferring it from the value keeps the rollback correct
    // even if that invariant ever changes.
    const hadPrevious = _offsets?.has(target) ?? false;
    const previous = hadPrevious ? _offsets!.get(target)! : 0;
    if (clamped === 0) {
        // A nonzero current value implies the map exists.
        _offsets?.delete(target);
    } else {
        (_offsets ??= new WeakMap()).set(target, clamped);
    }
    ensureInstalled();
    try {
        // Narrowest existing rebuild that both re-reads every run's draw-group key and rewrites
        // every style entry's params.y. It keeps the current run objects (`reset` with no `runs`
        // copies `data._runs`), compacts the slot allocator, and reuses the previous draw-group
        // object for every key that survives — so this feature re-implements none of the
        // allocator, grouping or style-packing logic.
        updateTextData(data, { update: "reset" });
    } catch (err) {
        // The map above already reflects the new offset — it is what the seam's `reset` just
        // read from — but the repack it was meant to drive never completed. Roll the map back
        // to the exact prior state (delete if this run had no entry, restore the previous value
        // if it did) so a retry with this same offset is not mistaken for the no-op guard above:
        // leaving the map at the new value would make a caller's retry after fixing the failure
        // silently do nothing instead of repacking. `data` itself, and the seams installed
        // above, are not rolled back; see the architecture doc's setter-lifecycle note.
        if (hadPrevious) {
            _offsets!.set(target, previous);
        } else {
            _offsets?.delete(target);
        }
        throw err;
    }
}
