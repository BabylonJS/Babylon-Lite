/** Public, structural types for the text feature. Re-exported from `src/index.ts`. */

export type QuadCurve = {
    readonly p0x: number;
    readonly p0y: number;
    readonly p1x: number;
    readonly p1y: number;
    readonly p2x: number;
    readonly p2y: number;
};

export type GlyphBounds = {
    readonly xMin: number;
    readonly yMin: number;
    readonly xMax: number;
    readonly yMax: number;
};

export type GlyphCurves = {
    readonly glyphId: number;
    readonly curves: readonly QuadCurve[];
    readonly bounds: GlyphBounds;
};

export type PlacedGlyph = {
    readonly glyphId: number;
    /** Pixel position of glyph baseline origin. */
    readonly x: number;
    readonly y: number;
};

export type GlyphRun = {
    readonly glyphs: readonly PlacedGlyph[];
    /** Pixel-space width of the whole laid-out run. */
    readonly width: number;
    /** Pixel-space height of the whole laid-out run. */
    readonly height: number;
    /** Font-units → pixels scale used by the layout. */
    readonly pixelsPerFontUnit: number;
};

export type TextDescriptor = {
    readonly curves: ReadonlyMap<number, GlyphCurves>;
    readonly run: GlyphRun;
};

export type TextLayoutOptions = {
    /** Max line width in pixels before word-wrap. Default: Infinity. */
    readonly maxWidth?: number;
    /** Line-height multiplier. Default: 1.2. */
    readonly lineHeight?: number;
    /** Horizontal alignment. Default: "left". */
    readonly align?: "left" | "center" | "right";
    /** Extra spacing in font units. Default: 0. */
    readonly letterSpacing?: number;
    /** Tab size in spaces. Default: 4. */
    readonly tabSize?: number;
};
