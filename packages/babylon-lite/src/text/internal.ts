/** @internal Brand symbols, lazy WeakMaps, and per-handle internal state for the text feature.
 *  Not re-exported from `src/index.ts`. */

import type { Font as TextShaperFont } from "text-shaper";
import type { GlyphCurves, GlyphRun, TextLayoutOptions } from "./public-types.js";
import type { GlyphBands } from "./slug-bands.js";

// ─── Brand symbols (nominal-typing only — never instantiated at runtime) ───
export declare const FONT_BRAND: unique symbol;
export declare const TEXT_DATA_BRAND: unique symbol;
export declare const DEFAULT_TEXT_DESCRIPTOR_BRAND: unique symbol;

// ─── Branded public types ───
export type Font = { readonly [FONT_BRAND]: never };
export type TextData = {
    readonly width: number;
    readonly height: number;
    readonly [TEXT_DATA_BRAND]: never;
};
export type DefaultTextDescriptor = {
    readonly curves: ReadonlyMap<number, GlyphCurves>;
    readonly run: GlyphRun;
    readonly [DEFAULT_TEXT_DESCRIPTOR_BRAND]: never;
};

// ─── Internal per-handle state ───
export type FontInternals = { font: TextShaperFont };

/** Atlas slot for a single glyph inside a SharedAtlas. */
export type AtlasSlot = {
    /** Index of the first curve texel for this glyph. */
    curveTexelStart: number;
    /** Texel coordinates of the band header block for this glyph. */
    glyphLocX: number;
    glyphLocY: number;
    /** vBandCount - 1, hBandCount - 1 (matching the fragment shader expectations). */
    bandMaxX: number;
    bandMaxY: number;
    /** Number of bands per axis used when packing (≤ 8). */
    vBandCount: number;
    hBandCount: number;
};

/** CPU + (lazy) GPU staging shared by every TextData built from the same curves map. */
export type SharedAtlas = {
    /** Pooled curve texel staging (rgba32float, width 4096). */
    curveTexData: Float32Array;
    /** Number of curve texels actually used. */
    curveTexelsUsed: number;
    /** Pooled band texel staging (rgba32float, width 4096). */
    bandTexData: Float32Array;
    /** Number of band texels actually used. */
    bandTexelsUsed: number;
    /** Per-glyph atlas slot lookup. Slots are append-only and never moved. */
    glyphSlots: Map<number, AtlasSlot>;
    /** Monotonic version bumped whenever a new glyph is appended. */
    version: number;
    /** Lazy GPU resources (one set per SharedAtlas; recreated only on capacity grow). */
    _gpu: SharedAtlasGpu | null;
};

export type SharedAtlasGpu = {
    device: GPUDevice;
    curveTex: GPUTexture;
    bandTex: GPUTexture;
    curveTexRows: number;
    bandTexRows: number;
    uploadedVersion: number;
};

export type TextDataInternals = {
    atlas: SharedAtlas;
    /** Pooled per-instance float buffer (12 floats per instance). */
    instances: Float32Array;
    instanceCount: number;
    /** Last seen `descriptor.curves.size` — fast-path skip when unchanged. */
    lastCurvesSize: number;
    /** Last seen curves map reference for identity check. */
    lastCurvesRef: ReadonlyMap<number, GlyphCurves> | null;
    /** Glyph ids known to the atlas at the time of the last update (for diffing). */
    knownGlyphIds: Set<number>;
    /** Monotonic version bumped on any structural change. */
    version: number;
    /** Lazy per-text-block GPU resources (instance buffer). */
    _gpu: TextDataGpu | null;
};

export type TextDataGpu = {
    device: GPUDevice;
    instanceBuf: GPUBuffer;
    instanceBufCapacity: number;
    uploadedVersion: number;
};

export type DefaultTextDescriptorInternals = {
    font: Font;
    fontSizePx: number;
    options: TextLayoutOptions | undefined;
};

// ─── Lazy WeakMaps (zero module-level side effects per GUIDANCE §4) ───
let _fontInternals: WeakMap<Font, FontInternals> | null = null;
let _textDataInternals: WeakMap<TextData, TextDataInternals> | null = null;
let _defaultDescriptorInternals: WeakMap<DefaultTextDescriptor, DefaultTextDescriptorInternals> | null = null;
let _atlasByCurves: WeakMap<ReadonlyMap<number, GlyphCurves>, SharedAtlas> | null = null;
let _curvesCacheByFont: WeakMap<Font, Map<number, GlyphCurves>> | null = null;
let _bandsCache: WeakMap<GlyphCurves, GlyphBands> | null = null;

export function getFontInternals(font: Font): FontInternals | undefined {
    return _fontInternals?.get(font);
}
export function setFontInternals(font: Font, state: FontInternals): void {
    (_fontInternals ??= new WeakMap()).set(font, state);
}

export function getTextDataInternals(data: TextData): TextDataInternals | undefined {
    return _textDataInternals?.get(data);
}
export function setTextDataInternals(data: TextData, state: TextDataInternals): void {
    (_textDataInternals ??= new WeakMap()).set(data, state);
}

export function getDefaultDescriptorInternals(d: DefaultTextDescriptor): DefaultTextDescriptorInternals | undefined {
    return _defaultDescriptorInternals?.get(d);
}
export function setDefaultDescriptorInternals(d: DefaultTextDescriptor, state: DefaultTextDescriptorInternals): void {
    (_defaultDescriptorInternals ??= new WeakMap()).set(d, state);
}

export function getSharedAtlasForCurves(curves: ReadonlyMap<number, GlyphCurves>): SharedAtlas | undefined {
    return _atlasByCurves?.get(curves);
}
export function setSharedAtlasForCurves(curves: ReadonlyMap<number, GlyphCurves>, atlas: SharedAtlas): void {
    (_atlasByCurves ??= new WeakMap()).set(curves, atlas);
}

export function getCurvesCacheForFont(font: Font): Map<number, GlyphCurves> {
    let cache = _curvesCacheByFont?.get(font);
    if (!cache) {
        cache = new Map();
        (_curvesCacheByFont ??= new WeakMap()).set(font, cache);
    }
    return cache;
}

export function getBandsCache(): WeakMap<GlyphCurves, GlyphBands> {
    return (_bandsCache ??= new WeakMap());
}

export const TEX_WIDTH = 4096;
