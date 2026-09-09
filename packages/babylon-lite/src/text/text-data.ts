/** TextData — slot-allocator-backed per-instance vertex buffer for a text block.
 *
 *  Each draw group owns a contiguous slot range `[slotStart, slotStart + slotCount)`
 *  in the shared instance buffer. Live and dead slots intermix within that range;
 *  dead slots carry an all-ones packed word that the vertex shader detects and turns
 *  into a degenerate off-screen triangle. `addRun` / `replaceRun` reuse
 *  from the group's `freeSlots` LIFO when possible; otherwise they extend the
 *  group's range (shifting later *groups* — never other runs in the same group).
 *  `removeRun` writes the sentinel into its slots and returns them to the free-list.
 *
 *  Each TextData is bound to one `GlyphStorage` for its glyph catalog. The storage is
 *  borrowed — caller owns its lifetime. `disposeTextData` releases the per-block
 *  instance buffer + bind groups only.
 *
 *  Cost per edit: O(touched glyphs) in the common single-font case, with an extra
 *  O(later-group slot count) shift only when the touched group must grow.
 */

import type { CurveSetId, GlyphStorage, GlyphStorageCurveSet } from "./glyph-storage.js";

declare const textDataBrand: unique symbol;

// ─── Public value types ───────────────────────────────────────────────────

/** Positioned glyph instance in pixel space, usually produced by layout before being packed into a `GlyphRun`. */
export type PlacedGlyph = {
    readonly glyphId: number;
    /** Pixel position of glyph baseline origin. */
    readonly x: number;
    readonly y: number;
    /** Optional per-glyph color as linear RGBA in [0,1]. When present this overrides the
     *  run's `defaultColor` for this glyph. When omitted, the glyph falls back to the run's
     *  `defaultColor`, and if that is also omitted, to opaque white. The rendered alpha is
     *  additionally scaled by the whole-block opacity (e.g. `TextRenderable.opacity`). */
    readonly color?: readonly [number, number, number, number];
};

/** Batch of placed glyphs that all use the same curve set and font-unit-to-pixel scale. */
export type GlyphRun = {
    /** Which curve set this run's glyph ids index into. */
    readonly curveSet: CurveSetId;
    readonly glyphs: readonly PlacedGlyph[];
    /** Font-units → pixels scale used by the layout. */
    readonly pixelsPerFontUnit: number;
    /** Optional default color for every glyph in this run, as linear RGBA in [0,1]. A glyph's
     *  own `PlacedGlyph.color` takes precedence over this. When omitted, glyphs default to
     *  opaque white. The rendered alpha is additionally scaled by the whole-block opacity. */
    readonly defaultColor?: readonly [number, number, number, number];
};

/** Discriminated union driving `updateTextData`. Each variant's `update` field is the
 *  discriminator. Arrays/maps passed inside any variant are *adopted* by the `TextData`
 *  and must not be read or mutated by the caller afterward. */
export type TextDataUpdate =
    | {
          /** Rebuild runs and/or swap to a different storage. Both `runs` and `storage`
           *  are optional; missing fields default to the TextData's current value, so
           *  `{ update: "reset" }` with neither performs a pure compaction pass that
           *  re-lays-out the slot allocator without dead slots or gaps.
           *  Invalidates any previously-passed `GlyphRun` references when `runs` is set. */
          update: "reset";
          runs?: GlyphRun[];
          storage?: GlyphStorage;
      }
    | {
          /** Append a new run to the live runs list, or insert it before the run currently at
           *  `insertBefore`. The run's `curveSet` must already exist in the bound storage. */
          update: "addRun";
          run: GlyphRun;
          /** Index in `data.runs` to insert before. Default = append at end. */
          insertBefore?: number;
      }
    | {
          /** Remove a previously-added run. Accepts either the `GlyphRun` reference or its
           *  current index in `data.runs`. */
          update: "removeRun";
          run: GlyphRun | number;
      }
    | {
          /** Replace one run's contents in place. The new run takes the slot in `data.runs`
           *  that the previous run occupied. Cheapest when the new run has the same glyph
           *  count and the same `curveSet` as the previous one. */
          update: "replaceRun";
          previous: GlyphRun | number;
          run: GlyphRun;
      };

// ─── Branded public type + internal supporting types ──────────────────────

/** Mutable text block data containing glyph runs and the packed per-glyph instance buffer consumed by text renderers. */
export interface TextData {
    readonly [textDataBrand]: true;
    /** Live, in-insertion-order view of the runs currently rendered. Mutated by
     *  `updateTextData`. Do not mutate from outside. */
    readonly runs: readonly GlyphRun[];
    /** @internal Mutable alias of {@link runs} (same array reference). */
    _runs: GlyphRun[];
    /** @internal Draw groups. Length = number of unique draw-group keys referenced (one per
     *  curve set unless a styling feature splits one further). */
    _groups: TextDataDrawGroup[];
    /** @internal Per-run bookkeeping records, keyed by `GlyphRun` reference. */
    _runRecords: Map<GlyphRun, RunRecord>;
    /** @internal Pooled per-instance float buffer (TEXT_INSTANCE_FLOATS per instance). */
    _instances: Float32Array;
    /** @internal Uint32 alias of {@link _instances} (same buffer), used for the packed glyph
     *  index. Always reassigned together with `_instances`. */
    _instancesU32: Uint32Array;
    /** @internal Total *capacity* used (live + dead slots across all groups). */
    _instanceCount: number;
    /** @internal Style palette: `TEXT_STYLE_FLOATS` per entry, indexed by the high 16 bits of
     *  an instance's packed word. */
    _styles: Float32Array;
    /** @internal High-water mark for allocated style entries. */
    _styleCount: number;
    /** @internal Reusable individual style indices. */
    _freeStyleSlots: number[];
    /** @internal Monotonic version bumped whenever `_styles` content changes, so renderers can
     *  skip the palette upload entirely when nothing moved. */
    _styleVersion: number;
    /** @internal GlyphStorage backing this TextData. Borrowed reference — caller owns it. */
    _storage: GlyphStorage;
    /** @internal Monotonic version bumped whenever instance data changes. */
    _version: number;
    /** @internal Monotonic version bumped only when the draw structure changes, i.e. when a
     *  group's slot range (`slotStart`/`slotCount`) moves. Content-only edits (same-length
     *  replace, add-into-free-slot, partial remove) leave this stable so cached render bundles
     *  stay valid. */
    _layoutVersion: number;
    /** @internal Inclusive-exclusive dirty range of instances awaiting upload. */
    _dirtyStart: number;
    /** @internal */ _dirtyEnd: number;
}

/** @internal Draw group within a TextData. One group per unique draw-group key — i.e. one per
 *  unique font used by the live runs, unless an opt-in styling feature splits a curve set
 *  further. Groups own a contiguous *slot range* in the shared instance buffer; live and dead
 *  slots intermix within that range. The vertex shader emits a degenerate quad for dead slots
 *  so they cost only a vertex-shader invocation. */
export type TextDataDrawGroup = {
    /** @internal Curve-set id (matches the key inside the parent storage's `_curveSets` map). */
    _curveSetId: CurveSetId;
    /** @internal Cached pointer to the curve-set entry within the parent TextData's `_storage`.
     *  Refreshed whenever `_storage` swaps in `applyReset`; identity-compared to invalidate
     *  the cached `_bindGroup`. */
    _curveSet: GlyphStorageCurveSet;
    /** @internal First slot index (in instances, not bytes) owned by this group. */
    _slotStart: number;
    /** @internal Number of slots reserved by this group (live + dead). The draw call covers
     *  `[_slotStart, _slotStart + _slotCount)`. */
    _slotCount: number;
    /** @internal Number of *live* (non-dead) instances in this group. Tracked for stats. */
    _liveCount: number;
    /** @internal Indices (absolute, within `TextData._instances`) of dead slots inside this group's
     *  range, available for reuse by `addRun`/`replaceRun`. LIFO order keeps recent frees
     *  reusable first (locality). */
    _freeSlots: number[];
    /** @internal Lazy GPU bind group for this group's atlas (recreated on atlas-grow or first bind). */
    _bindGroup: GPUBindGroup | null;
    /** @internal Atlas-GPU upload version captured when `_bindGroup` was last (re)built. */
    _bindGroupVersion: number;
    /** @internal Draw-group identity. Equals `_curveSetId` unless an opt-in styling feature
     *  interned a different key for these runs, in which case the group needs the composed
     *  variant pipeline — `_groupKey !== _curveSetId` is exactly that test. */
    _groupKey: TextGroupKey;
};

/** @internal Per-run bookkeeping. Lets us locate a run's instances inside its draw group's
 *  slot range in O(1) for add/remove/replace ops. Slots are not guaranteed to be contiguous
 *  (the allocator may have reused freed slots from anywhere in the group's range). */
export type RunRecord = {
    /** @internal */
    _run: GlyphRun;
    /** @internal Index of the owning draw group in `TextData._groups`. */
    _groupIdx: number;
    /** @internal Absolute slot indices (within `TextData._instances`) currently occupied by this run.
     *  Length === number of glyphs actually written (skipped glyphs do not occupy slots). */
    _slots: number[];
    /** @internal Style indices owned by this run: default first, then color overrides in glyph order. */
    _styleSlots: number[];
};

/** Floats per instance: the anchor (x, y) plus one packed u32 holding the glyph index in its
 *  low 16 bits and the style index in its high 16. Everything else the shader needs is either
 *  glyph-invariant — the atlas's `GlyphMetadata` table, indexed by the glyph half — or shared
 *  by every glyph drawn at the same color and scale — this TextData's style palette, indexed
 *  by the style half. Neither is copied per instance. */
export const TEXT_INSTANCE_FLOATS = 3;
export const TEXT_INSTANCE_BYTES = TEXT_INSTANCE_FLOATS * 4;

/** Floats per style-palette entry, matching the WGSL `TextStyle` struct: a `vec4<f32>` color
 *  followed by a `vec4<f32>` of params whose `.x` carries the run's `invScale` and whose `.y`
 *  carries the optional per-run style parameter (see {@link TextStyleSeam}; 0 when no styling
 *  feature is installed). The rest is reserved padding that keeps the struct naturally
 *  16-byte aligned. */
export const TEXT_STYLE_FLOATS = 8;
export const TEXT_STYLE_BYTES = TEXT_STYLE_FLOATS * 4;

/** Value of the packed word marking a slot as dead (skipped by the vertex shader). Both halves
 *  are all-ones, which `MAX_PACKED_INDEX` keeps unreachable for a real (glyph, style) pair. */
const DEAD_GLYPH = 0xffffffff;

/** Largest glyph or style index representable in a packed half. `0xffff` is reserved so the
 *  dead sentinel stays unambiguous. */
const MAX_PACKED_INDEX = 0xfffe;
const MAX_STYLE_ENTRIES = MAX_PACKED_INDEX + 1;

const WHITE_COLOR: readonly [number, number, number, number] = [1, 1, 1, 1];

// ─── Optional per-run styling seam ─────────────────────────────────────────
// Installed by an opt-in styling feature (currently `set-font-weight-offset.ts`) from
// inside its setter; null otherwise. This module attaches no meaning to either result:
// `_param` is a float copied verbatim into `TextStyle.params.y`, `_key` is a token
// compared only with `===`. All feature semantics live in the installing module.

/** @internal Opaque draw-group identity, compared by `===` only. The default is the run's
 *  own {@link CurveSetId}; a styling feature may substitute an interned non-string token,
 *  which by construction can never equal a curve-set id — so no composite/delimited key can
 *  make one curve set's group alias another's. */
export type TextGroupKey = CurveSetId | object;

/** @internal Per-run styling hooks supplied by an opt-in feature. */
export interface TextStyleSeam {
    /** @internal Draw-group key for a run — must be `run.curveSet` unless the run needs a
     *  different pipeline variant, and must never equal another curve set's key. */
    _key(run: GlyphRun): TextGroupKey;
    /** @internal Extra style float, packed verbatim into `TextStyle.params.y`. */
    _param(run: GlyphRun): number;
}

/** @internal */
export let _textStyleSeam: TextStyleSeam | null = null;

/** @internal Install the styling seam. Called once by the opt-in setter. */
export function _installTextStyleSeam(seam: TextStyleSeam): void {
    _textStyleSeam = seam;
}

/** Draw-group key for a run: its curve set unless a styling feature interned another. */
function runGroupKey(run: GlyphRun): TextGroupKey {
    return _textStyleSeam?._key(run) ?? run.curveSet;
}

// ─── Per-slot packing ──────────────────────────────────────────────────────

function packGlyphAtSlot(out: Float32Array, outU32: Uint32Array, slot: number, curveSet: GlyphStorageCurveSet, glyphId: number, x: number, y: number, styleIdx: number): boolean {
    // An atlas slot exists only for glyphs that are also in `curveSet._curves` (both maps are
    // written together and never pruned), so this single lookup doubles as the validity check.
    // It yields an index into the atlas's glyph-metadata buffer; everything glyph-invariant
    // lives there and is never copied into the instance.
    const atlasSlot = curveSet._atlas._glyphSlots.get(glyphId);
    if (!atlasSlot) {
        return false;
    }
    const glyphIdx = atlasSlot._index;
    // Both indices share one u32, so an out-of-range value would silently alias a different
    // glyph or style — or the dead sentinel. Drop the glyph instead; the caller already treats
    // a false return as an atlas miss and retires the slot.
    if (glyphIdx > MAX_PACKED_INDEX || styleIdx > MAX_PACKED_INDEX) {
        return false;
    }
    const w = slot * TEXT_INSTANCE_FLOATS;
    out[w] = x;
    out[w + 1] = y;
    outU32[w + 2] = glyphIdx | (styleIdx << 16);
    return true;
}

function markSlotDead(out: Float32Array, outU32: Uint32Array, slot: number): void {
    const base = slot * TEXT_INSTANCE_FLOATS;
    out[base] = 0;
    out[base + 1] = 0;
    outU32[base + 2] = DEAD_GLYPH;
}

// ─── Style palette ─────────────────────────────────────────────────────────

function ensureStyleCapacity(data: TextData, requiredEntries: number): void {
    if (requiredEntries > MAX_STYLE_ENTRIES) {
        throw new Error(`TextData style palette cannot exceed ${MAX_STYLE_ENTRIES} entries.`);
    }
    const requiredFloats = requiredEntries * TEXT_STYLE_FLOATS;
    if (data._styles.length >= requiredFloats) {
        return;
    }
    let newLen = Math.max(data._styles.length * 2, TEXT_STYLE_FLOATS);
    while (newLen < requiredFloats) {
        newLen *= 2;
    }
    newLen = Math.min(newLen, MAX_STYLE_ENTRIES * TEXT_STYLE_FLOATS);
    const grown = new Float32Array(newLen);
    grown.set(data._styles);
    data._styles = grown;
}

/** Palette entries a run needs: one shared default plus one per glyph carrying its own `color`.
 *  Overrides are deliberately not deduplicated — a dedicated entry per override glyph lets the
 *  write loop hand them out in glyph order instead of searching the palette, and even the
 *  pathological all-override case costs less per glyph (12 B instance + 32 B entry) than the
 *  80 B instances this format replaced. */
function countRunStyles(run: GlyphRun): number {
    const glyphs = run.glyphs;
    let n = 1;
    for (let i = 0; i < glyphs.length; i++) {
        if (glyphs[i]!.color !== undefined) {
            n++;
        }
    }
    return n;
}

function releaseStyles(data: TextData, slots: number[]): void {
    for (let i = 0; i < slots.length; i++) {
        data._freeStyleSlots.push(slots[i]!);
    }
}

function allocateStyles(data: TextData, count: number, previous?: number[]): number[] {
    if (previous?.length === count) {
        return previous;
    }
    const free = data._freeStyleSlots;
    const needed = Math.max(0, count - free.length - (previous?.length ?? 0));
    ensureStyleCapacity(data, data._styleCount + needed);
    if (previous) {
        releaseStyles(data, previous);
    }
    const highWater = data._styleCount;
    const slots = new Array<number>(count);
    for (let i = 0; i < count; i++) {
        slots[i] = free.pop() ?? data._styleCount++;
    }
    // Growing past the high-water mark lengthens the upload, and `ensureStyleGpu` only uploads
    // when the version moved — so the bump cannot be left to `writeStyle`, which stays silent for
    // an entry whose contents already match (an all-zero style writes nothing). Slots taken from
    // the free list keep the upload length unchanged, so there `writeStyle` alone is enough.
    if (data._styleCount !== highWater) {
        data._styleVersion++;
    }
    return slots;
}

/** Write one palette entry, bumping `_styleVersion` only when the entry's contents actually
 *  change. Comparing against the `Math.fround` of each value rather than the value itself is
 *  what makes that check meaningful: the palette stores float32, so a double like `1 / 13.3`
 *  never compares equal to its own stored form and every frame would look like a change. */
function writeStyle(data: TextData, entry: number, color: readonly [number, number, number, number], invScale: number, styleParam: number): void {
    const w = entry * TEXT_STYLE_FLOATS;
    const s = data._styles;
    const r = Math.fround(color[0]);
    const g = Math.fround(color[1]);
    const b = Math.fround(color[2]);
    const a = Math.fround(color[3]);
    const iv = Math.fround(invScale);
    const sp = Math.fround(styleParam);
    if (s[w] === r && s[w + 1] === g && s[w + 2] === b && s[w + 3] === a && s[w + 4] === iv && s[w + 5] === sp) {
        return;
    }
    s[w] = r;
    s[w + 1] = g;
    s[w + 2] = b;
    s[w + 3] = a;
    s[w + 4] = iv;
    s[w + 5] = sp;
    data._styleVersion++;
}

// ─── Buffer + dirty-range helpers ──────────────────────────────────────────

function ensureInstanceCapacity(data: TextData, requiredInstances: number): void {
    const requiredFloats = requiredInstances * TEXT_INSTANCE_FLOATS;
    if (data._instances.length >= requiredFloats) {
        return;
    }
    let newLen = Math.max(data._instances.length * 2, TEXT_INSTANCE_FLOATS);
    while (newLen < requiredFloats) {
        newLen *= 2;
    }
    const grown = new Float32Array(newLen);
    grown.set(data._instances.subarray(0, data._instanceCount * TEXT_INSTANCE_FLOATS));
    data._instances = grown;
    data._instancesU32 = new Uint32Array(grown.buffer);
    data._dirtyStart = 0;
    data._dirtyEnd = data._instanceCount;
}

function markDirty(data: TextData, startInstance: number, endInstance: number): void {
    if (endInstance <= startInstance) {
        return;
    }
    if (data._dirtyStart === data._dirtyEnd) {
        data._dirtyStart = startInstance;
        data._dirtyEnd = endInstance;
    } else {
        if (startInstance < data._dirtyStart) {
            data._dirtyStart = startInstance;
        }
        if (endInstance > data._dirtyEnd) {
            data._dirtyEnd = endInstance;
        }
    }
    data._version++;
}

// ─── Slot allocator ────────────────────────────────────────────────────────

/** Pop a slot from `group._freeSlots`, or -1 if none. */
function popFreeSlot(group: TextDataDrawGroup): number {
    return group._freeSlots.length > 0 ? group._freeSlots.pop()! : -1;
}

/** Shift every group `slotStart` / freeSlot / run-record slot at or after `threshold` by
 *  `delta` (positive to open a gap, negative to close one). `exclude` — a group being grown
 *  in place — is skipped so its own range isn't shifted; run-record slots are always shifted. */
function shiftSlotsAtOrAfter(data: TextData, threshold: number, delta: number, exclude?: TextDataDrawGroup): void {
    for (const g of data._groups) {
        if (g !== exclude && g._slotStart >= threshold) {
            g._slotStart += delta;
            for (let i = 0; i < g._freeSlots.length; i++) {
                g._freeSlots[i] = g._freeSlots[i]! + delta;
            }
        }
    }
    for (const rec of data._runRecords.values()) {
        const slots = rec._slots;
        for (let i = 0; i < slots.length; i++) {
            if (slots[i]! >= threshold) {
                slots[i] = slots[i]! + delta;
            }
        }
    }
    // Slot ranges moved — cached render bundles keyed on `_layoutVersion` must rebuild.
    data._layoutVersion++;
}

/** Grow `group` by `extraSlots`. Returns the absolute index of the first newly-added
 *  slot. Shifts later groups' slot ranges right by `extraSlots` and rewrites any run
 *  slot indices that fall in the shifted range. Marks the shifted region dirty. */
function growGroup(data: TextData, group: TextDataDrawGroup, extraSlots: number): number {
    const insertAt = group._slotStart + group._slotCount;
    if (extraSlots <= 0) {
        return insertAt;
    }
    ensureInstanceCapacity(data, data._instanceCount + extraSlots);
    const floatDelta = extraSlots * TEXT_INSTANCE_FLOATS;
    const moveStartFloat = insertAt * TEXT_INSTANCE_FLOATS;
    const moveEndFloat = data._instanceCount * TEXT_INSTANCE_FLOATS;
    if (moveEndFloat > moveStartFloat) {
        data._instances.copyWithin(moveStartFloat + floatDelta, moveStartFloat, moveEndFloat);
    }
    // Shift later groups (and their runs) right to open the gap for the new slots.
    shiftSlotsAtOrAfter(data, insertAt, extraSlots, group);
    data._instanceCount += extraSlots;
    group._slotCount += extraSlots;
    // Newly-added slots and the shifted region are dirty.
    markDirty(data, insertAt, data._instanceCount);
    return insertAt;
}

/** Allocate `count` slots for `group`. Reuses free slots first, then extends. Returns
 *  the array of absolute slot indices in ascending order. */
function allocateSlots(data: TextData, group: TextDataDrawGroup, count: number): number[] {
    // `.fill` is what keeps this PACKED_SMI_ELEMENTS in V8. A bare `new Array(count)` is
    // holey, and `writeRunToSlots` hands this exact array straight to a run record, so the
    // holeyness would leak into `shiftSlotsAtOrAfter`'s hot per-slot loop and halve its
    // throughput.
    const out: number[] = new Array(count).fill(-1);
    // Instances are drawn in slot order, so a run's glyphs have to land on ascending slots or
    // overlapping ones composite in the wrong order. `popFreeSlot` hands reclaimed slots back
    // LIFO, so a block that was just freed comes back reversed. Track that while filling instead
    // of rescanning afterwards, and sort only when it actually happened: `sort` runs a comparator
    // call per element even on already-ordered input, which is pure overhead on the common path.
    let sorted = true;
    let prevSlot = -1;
    let reused = count;
    for (let i = 0; i < count; i++) {
        const slot = popFreeSlot(group);
        // Nothing refills the free list mid-loop, so the rest of `out` comes from the extension.
        if (slot === -1) {
            reused = i;
            break;
        }
        out[i] = slot;
        sorted &&= slot >= prevSlot;
        prevSlot = slot;
    }
    if (reused < count) {
        const firstNewSlot = growGroup(data, group, count - reused);
        // Extension slots are appended past the group's tail and ascend from there, so only the
        // seam against the reused prefix can be out of order.
        sorted &&= firstNewSlot >= prevSlot;
        for (let i = reused, n = firstNewSlot; i < count; i++) {
            out[i] = n++;
        }
    }
    if (!sorted) {
        out.sort(ascendingSlot);
    }
    return out;
}

function ascendingSlot(a: number, b: number): number {
    return a - b;
}

/** Release `slots` back to `group._freeSlots`, marking each dead in the buffer. */
function freeSlots(data: TextData, group: TextDataDrawGroup, slots: number[]): void {
    let minSlot = Number.POSITIVE_INFINITY;
    let maxSlot = -1;
    for (const s of slots) {
        markSlotDead(data._instances, data._instancesU32, s);
        group._freeSlots.push(s);
        if (s < minSlot) {
            minSlot = s;
        }
        if (s > maxSlot) {
            maxSlot = s;
        }
    }
    if (maxSlot >= 0) {
        markDirty(data, minSlot, maxSlot + 1);
    }
}

// ─── Draw-group helpers ────────────────────────────────────────────────────

function findGroup(data: TextData, groupKey: TextGroupKey): TextDataDrawGroup | undefined {
    for (const g of data._groups) {
        if (g._groupKey === groupKey) {
            return g;
        }
    }
    return undefined;
}

function lookupCurveSet(storage: GlyphStorage, curveSetId: CurveSetId, op: string): GlyphStorageCurveSet {
    const cs = storage._curveSets.get(curveSetId);
    if (!cs) {
        throw new Error(`updateTextData ${op}: storage does not contain curveSet "${curveSetId}" — add it via updateGlyphStorage first.`);
    }
    return cs;
}

/** Build a fresh draw group for `groupKey` starting at absolute slot `slotStart`. */
function makeDrawGroup(curveSetId: CurveSetId, curveSet: GlyphStorageCurveSet, slotStart: number, groupKey: TextGroupKey): TextDataDrawGroup {
    return {
        _curveSetId: curveSetId,
        _curveSet: curveSet,
        _slotStart: slotStart,
        _slotCount: 0,
        _liveCount: 0,
        _freeSlots: [],
        _bindGroup: null,
        _bindGroupVersion: -1,
        _groupKey: groupKey,
    };
}

function ensureGroup(data: TextData, curveSetId: CurveSetId, groupKey: TextGroupKey): TextDataDrawGroup {
    const existing = findGroup(data, groupKey);
    if (existing) {
        return existing;
    }
    const curveSet = lookupCurveSet(data._storage, curveSetId, "addRun");
    const group = makeDrawGroup(curveSetId, curveSet, data._instanceCount, groupKey);
    data._groups.push(group);
    return group;
}

/** Write a run's glyphs into the given (already-allocated) instance and style slots.
 *  Returns the subset of instance slots that actually received
 *  live glyphs (skipped glyphs leave their slot dead). When every glyph lands — the
 *  overwhelmingly common case — that subset *is* `slots`, and the caller gets the same array
 *  back rather than a freshly built copy. */
function writeRunToSlots(data: TextData, group: TextDataDrawGroup, run: GlyphRun, slots: number[], styleSlots: number[]): number[] {
    const ratio = run.pixelsPerFontUnit;
    const invScale = ratio !== 0 ? 1 / ratio : 0;
    const styleParam = _textStyleSeam?._param(run) ?? 0;
    const defaultStyle = styleSlots[0]!;
    writeStyle(data, defaultStyle, run.defaultColor ?? WHITE_COLOR, invScale, styleParam);
    let overrideEntry = 0;
    // Materialized only once a glyph actually misses the atlas, seeded with the prefix that
    // did land; while it stays null, `slots` is by definition the live set.
    let liveSlots: number[] | null = null;
    let minSlot = Number.POSITIVE_INFINITY;
    let maxSlot = -1;
    for (let i = 0; i < run.glyphs.length; i++) {
        const pg = run.glyphs[i]!;
        const slot = slots[i]!;
        let styleIdx = defaultStyle;
        const color = pg.color;
        if (color !== undefined) {
            styleIdx = styleSlots[++overrideEntry]!;
            writeStyle(data, styleIdx, color, invScale, styleParam);
        }
        const ok = packGlyphAtSlot(data._instances, data._instancesU32, slot, group._curveSet, pg.glyphId, pg.x, pg.y, styleIdx);
        if (!ok) {
            if (liveSlots === null) {
                liveSlots = slots.slice(0, i);
            }
            markSlotDead(data._instances, data._instancesU32, slot);
            group._freeSlots.push(slot);
        } else if (liveSlots !== null) {
            liveSlots.push(slot);
        }
        if (slot < minSlot) {
            minSlot = slot;
        }
        if (slot > maxSlot) {
            maxSlot = slot;
        }
    }
    if (maxSlot >= 0) {
        markDirty(data, minSlot, maxSlot + 1);
    }
    return liveSlots ?? slots;
}

// ─── reset (also serves as compaction) ─────────────────────────────────────

function applyReset(data: TextData, runs: readonly GlyphRun[], storage: GlyphStorage): void {
    // Pre-reserve capacity for total glyphs across all runs.
    let totalGlyphs = 0;
    let totalStyles = 0;
    for (const run of runs) {
        totalGlyphs += run.glyphs.length;
        totalStyles += countRunStyles(run);
    }
    ensureStyleCapacity(data, totalStyles);
    const required = totalGlyphs * TEXT_INSTANCE_FLOATS;
    if (data._instances.length < required) {
        let newLen = Math.max(data._instances.length * 2, TEXT_INSTANCE_FLOATS);
        while (newLen < required) {
            newLen *= 2;
        }
        data._instances = new Float32Array(newLen);
        data._instancesU32 = new Uint32Array(data._instances.buffer);
    }

    // Preserve previous groups for bind-group reuse when the draw-group key matches. The key
    // is the run's exact `CurveSetId` unless a styling feature interned another token, and it
    // is compared by identity — never a delimited composite string, which would let a curve
    // set whose id already ends in the delimiter+suffix collide with another curve set's
    // variant group.
    const prevGroupByKey = new Map<TextGroupKey, TextDataDrawGroup>();
    for (const g of data._groups) {
        prevGroupByKey.set(g._groupKey, g);
    }

    data._storage = storage;

    // Group runs by draw-group key so each group's slots are contiguous initially.
    const runsByKey = new Map<TextGroupKey, GlyphRun[]>();
    for (const run of runs) {
        const key = runGroupKey(run);
        let list = runsByKey.get(key);
        if (!list) {
            list = [];
            runsByKey.set(key, list);
        }
        list.push(run);
    }

    const newGroups: TextDataDrawGroup[] = [];
    const newRunRecords = new Map<GlyphRun, RunRecord>();
    let writeSlot = 0;
    // A reset rebuilds the palette densely and drops all free-slot state.
    data._styleCount = 0;
    data._freeStyleSlots.length = 0;
    data._styleVersion++;

    for (const [key, groupRuns] of runsByKey) {
        // Every run in a group shares one curve set: the key is either the curve-set id
        // itself or a token the styling feature interned per curve set.
        const curveSetId = groupRuns[0]!.curveSet;
        const curveSet = lookupCurveSet(storage, curveSetId, "reset");

        const existing = prevGroupByKey.get(key);
        const group: TextDataDrawGroup = existing ?? makeDrawGroup(curveSetId, curveSet, writeSlot, key);
        // Re-point cached curveSet at the (possibly new) storage's entry; invalidate
        // bind group when the underlying GlyphStorageCurveSet identity changed.
        if (group._curveSet !== curveSet) {
            group._curveSet = curveSet;
            group._bindGroup = null;
            group._bindGroupVersion = -1;
        }
        group._slotStart = writeSlot;
        group._freeSlots = [];

        const groupIdx = newGroups.length;
        let liveInGroup = 0;
        for (const run of groupRuns) {
            // Packed for the same reason as in `allocateSlots` — this array becomes the run
            // record's slot list.
            const slots: number[] = new Array(run.glyphs.length).fill(-1);
            for (let i = 0; i < run.glyphs.length; i++) {
                slots[i] = writeSlot++;
            }
            const styleCount = countRunStyles(run);
            const styleSlots = new Array<number>(styleCount);
            for (let i = 0; i < styleCount; i++) {
                styleSlots[i] = data._styleCount++;
            }
            const live = writeRunToSlots(data, group, run, slots, styleSlots);
            liveInGroup += live.length;
            newRunRecords.set(run, { _run: run, _groupIdx: groupIdx, _slots: live, _styleSlots: styleSlots });
        }
        group._slotCount = writeSlot - group._slotStart;
        group._liveCount = liveInGroup;
        newGroups.push(group);
    }

    data._instanceCount = writeSlot;
    data._groups = newGroups;
    data._runs.length = 0;
    for (const r of runs) {
        data._runs.push(r);
    }
    data._runRecords = newRunRecords;

    data._dirtyStart = 0;
    data._dirtyEnd = writeSlot;
    data._version++;
    data._layoutVersion++;
}

// ─── addRun / removeRun / replaceRun ───────────────────────────────────────

function resolveRun(data: TextData, ref: GlyphRun | number): GlyphRun {
    return typeof ref === "number" ? _resolveRunRef(data, ref, "updateTextData") : ref;
}

/** @internal Resolve a public `GlyphRun | number` reference against `data`'s live runs, so
 *  an opt-in per-run feature setter validates its argument exactly the way `updateTextData`
 *  does and throws the same shape of message. `op` prefixes that message.
 *
 *  Unlike the internal `resolveRun`, an object reference is *checked for membership*: a
 *  feature setter is a standalone entry point, so it cannot rely on a caller having already
 *  looked the run's record up. `updateTextData`'s index path shares this function, so the
 *  index bound check can never drift between the two. */
export function _resolveRunRef(data: TextData, ref: GlyphRun | number, op: string): GlyphRun {
    if (typeof ref === "number") {
        const r = data._runs[ref];
        if (!r) {
            throw new Error(`${op}: run index ${ref} out of range (0..${data._runs.length - 1}).`);
        }
        return r;
    }
    if (!data._runRecords.has(ref)) {
        throw new Error(`${op}: GlyphRun reference is not in this TextData.`);
    }
    return ref;
}

/** Index of `ref` within `data._runs`, or -1 when it is not present. A numeric ref *is* that
 *  index (already range-checked by `resolveRun`), so it costs nothing; only an object ref
 *  needs the O(run count) scan — resolve it lazily, and only when the answer is actually used. */
function resolveRunIndex(data: TextData, ref: GlyphRun | number): number {
    return typeof ref === "number" ? ref : data._runs.indexOf(ref);
}

function applyAddRun(data: TextData, run: GlyphRun, insertBefore?: number): void {
    if (data._runRecords.has(run)) {
        throw new Error("updateTextData addRun: GlyphRun reference is already in this TextData.");
    }
    const at = insertBefore ?? data._runs.length;
    lookupCurveSet(data._storage, run.curveSet, "addRun");
    const styleSlots = allocateStyles(data, countRunStyles(run));
    const group = ensureGroup(data, run.curveSet, runGroupKey(run));
    const groupIdx = data._groups.indexOf(group);
    const slots = allocateSlots(data, group, run.glyphs.length);
    const live = writeRunToSlots(data, group, run, slots, styleSlots);
    group._liveCount += live.length;
    data._runRecords.set(run, { _run: run, _groupIdx: groupIdx, _slots: live, _styleSlots: styleSlots });
    data._runs.splice(at, 0, run);
}

function applyRemoveRun(data: TextData, ref: GlyphRun | number): void {
    const run = resolveRun(data, ref);
    const rec = data._runRecords.get(run);
    if (!rec) {
        throw new Error("updateTextData removeRun: GlyphRun reference is not in this TextData.");
    }
    const group = data._groups[rec._groupIdx]!;
    freeSlots(data, group, rec._slots);
    group._liveCount -= rec._slots.length;
    releaseStyles(data, rec._styleSlots);
    data._runRecords.delete(run);
    const runIdx = resolveRunIndex(data, ref);
    if (runIdx >= 0) {
        data._runs.splice(runIdx, 1);
    }
    // If the group has no live instances left, drop it entirely and shrink the buffer tail.
    if (group._liveCount === 0) {
        dropEmptyGroup(data, group);
    }
}

/** Remove a group with no live instances. Shifts later groups left over the vacated range.
 *  The group's borrowed curveSet is left intact — caller owns the GlyphStorage lifetime. */
function dropEmptyGroup(data: TextData, group: TextDataDrawGroup): void {
    const idx = data._groups.indexOf(group);
    if (idx < 0) {
        return;
    }
    const removedStart = group._slotStart;
    const removedCount = group._slotCount;
    data._groups.splice(idx, 1);
    // Re-index groupIdx for runs in later groups.
    for (const r of data._runRecords.values()) {
        if (r._groupIdx > idx) {
            r._groupIdx--;
        }
    }
    if (removedCount > 0) {
        const floatDelta = removedCount * TEXT_INSTANCE_FLOATS;
        const moveStartFloat = (removedStart + removedCount) * TEXT_INSTANCE_FLOATS;
        const moveEndFloat = data._instanceCount * TEXT_INSTANCE_FLOATS;
        if (moveEndFloat > moveStartFloat) {
            data._instances.copyWithin(moveStartFloat - floatDelta, moveStartFloat, moveEndFloat);
        }
        // Close the gap left by the removed group (its runs are already gone).
        shiftSlotsAtOrAfter(data, removedStart, -removedCount);
        data._instanceCount -= removedCount;
        markDirty(data, removedStart, data._instanceCount);
    }
}

function applyReplaceRun(data: TextData, prevRef: GlyphRun | number, newRun: GlyphRun): void {
    const prev = resolveRun(data, prevRef);
    const rec = data._runRecords.get(prev);
    if (!rec) {
        throw new Error("updateTextData replaceRun: previous GlyphRun reference is not in this TextData.");
    }
    if (prev !== newRun && data._runRecords.has(newRun)) {
        throw new Error("updateTextData replaceRun: new GlyphRun reference is already in this TextData.");
    }
    const group = data._groups[rec._groupIdx]!;
    // Staying in the same draw group means the run keeps its position in `_runs`, so the whole
    // edit reduces to slot bookkeeping — no list splices, and no index scan to drive them. An
    // empty new run is the one exception: it can leave the group with nothing live, and only
    // the remove path knows how to retire a group.
    if (runGroupKey(newRun) === group._groupKey && newRun.glyphs.length > 0) {
        const styleSlots = allocateStyles(data, countRunStyles(newRun), rec._styleSlots);
        const prevSlotCount = rec._slots.length;
        let slots = rec._slots;
        if (newRun.glyphs.length !== prevSlotCount) {
            // Glyph count changed, so this run hands its slots back to the group's free list and
            // takes a fresh block. It reclaims most of them immediately — the allocator pops the
            // slots it just freed — so the write stays within roughly the same buffer range.
            freeSlots(data, group, slots);
            slots = allocateSlots(data, group, newRun.glyphs.length);
        }
        const live = writeRunToSlots(data, group, newRun, slots, styleSlots);
        // Absorbs both a changed glyph count and any glyph that missed the atlas.
        group._liveCount += live.length - prevSlotCount;
        if (prev === newRun) {
            // In-place glyph edits: the record and `_runs` already point at this run, so its
            // live instance and style slot lists are the only things that can have moved.
            rec._slots = live;
            rec._styleSlots = styleSlots;
        } else {
            data._runRecords.delete(prev);
            data._runRecords.set(newRun, { _run: newRun, _groupIdx: rec._groupIdx, _slots: live, _styleSlots: styleSlots });
            const runIdx = resolveRunIndex(data, prevRef);
            if (runIdx >= 0) {
                data._runs[runIdx] = newRun;
            }
        }
        return;
    }
    // Different curve set, or an empty replacement → remove + add at the same position.
    const insertPos = resolveRunIndex(data, prevRef);
    lookupCurveSet(data._storage, newRun.curveSet, "replaceRun");
    if (countRunStyles(newRun) > data._freeStyleSlots.length + rec._styleSlots.length + MAX_STYLE_ENTRIES - data._styleCount) {
        throw new Error(`TextData style palette cannot exceed ${MAX_STYLE_ENTRIES} entries.`);
    }
    applyRemoveRun(data, insertPos >= 0 ? insertPos : prev);
    applyAddRun(data, newRun, insertPos >= 0 ? insertPos : undefined);
}

// ─── Public API ────────────────────────────────────────────────────────────

/** Create a TextData bound to `storage`. If `runs` is omitted the TextData starts empty;
 *  runs can be appended later via `updateTextData({ update: "addRun", … })`. */
export function createTextData(storage: GlyphStorage, runs?: readonly GlyphRun[]): TextData {
    const runsArray: GlyphRun[] = [];
    const instances = new Float32Array(TEXT_INSTANCE_FLOATS);
    const data = {
        runs: runsArray,
        _runs: runsArray,
        _groups: [],
        _runRecords: new Map(),
        _instances: instances,
        _instancesU32: new Uint32Array(instances.buffer),
        _instanceCount: 0,
        _styles: new Float32Array(TEXT_STYLE_FLOATS),
        _styleCount: 0,
        _freeStyleSlots: [],
        _styleVersion: 1,
        _storage: storage,
        _version: 1,
        _layoutVersion: 0,
        _dirtyStart: 0,
        _dirtyEnd: 0,
    } as unknown as TextData;
    if (runs && runs.length > 0) {
        applyReset(data, runs, storage);
    }
    return data;
}

/** Apply an incremental edit to a `TextData`, such as adding, removing, replacing, or compacting runs.
 *
 *  @param data - Text data block to update.
 *  @param update - Discriminated update operation to apply. */
export function updateTextData(data: TextData, update: TextDataUpdate): void {
    switch (update.update) {
        case "reset": {
            // Defaults for compaction: keep current runs (defensive copy — applyReset
            // mutates data._runs in place) and current storage.
            const runs = update.runs ?? data._runs.slice();
            const storage = update.storage ?? data._storage;
            applyReset(data, runs, storage);
            return;
        }
        case "addRun":
            applyAddRun(data, update.run, update.insertBefore);
            return;
        case "removeRun":
            applyRemoveRun(data, update.run);
            return;
        case "replaceRun":
            applyReplaceRun(data, update.previous, update.run);
            return;
    }
}

/** Release per-block GPU resources owned by `data`. Does NOT dispose the bound
 *  `GlyphStorage` — caller owns its lifetime and must dispose it separately via
 *  `disposeGlyphStorage` once no `TextData` references it. */
export function disposeTextData(data: TextData): void {
    for (const g of data._groups) {
        g._bindGroup = null;
    }
    data._groups = [];
    data._instanceCount = 0;
    data._styleCount = 0;
    data._freeStyleSlots.length = 0;
    data._runs.length = 0;
    data._runRecords.clear();
}
