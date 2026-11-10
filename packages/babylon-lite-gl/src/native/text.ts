/**
 * Native Slug text stack — DECLARED DIVERGENCE (`caps.textRendering` is false).
 *
 * The WebGL text renderer depends on an integer GPU pipeline Babylon Native's
 * shader/vertex path does not expose: per-instance `uint` attributes
 * (`vertexAttribIPointer`) for glyph instances and `usampler2D` + `texelFetch`
 * reads of the `rg32uint` band atlas. Native's `VertexArray` only accepts float
 * attribute formats, so the text renderer cannot be backed.
 *
 * Behavior (same signatures as the WebGL `text/*` modules):
 *  - Pure CPU font helpers (`loadFont`, `createFontFromBuffer`,
 *    `extractGlyphCurves`, `cubicToQuadratics`) are the WebGL implementations,
 *    re-exported from the barrel — they have no GPU or DOM dependency.
 *  - `createTextLayer` / `setTextLayerPosition` are plain-object helpers and work.
 *  - Everything that creates or updates GPU-backed text state throws
 *    `lite-gl: <fn> is not supported on Babylon Native`.
 *  - Disposal / unregistration are no-ops; `isTextRendererReady` returns `false`
 *    and `removeTextRendererLayer` returns `false` (nothing can be registered).
 */
import type { GLEngineContext } from "./native-context.js";
import type { GLFont } from "../text/font.js";
import type { GLCurveSetId, GLGlyphCurves, GLGlyphStorage } from "../text/glyph-storage.js";
import type { GLGlyphRun, GLTextData, GLTextDataUpdate } from "../text/text-data.js";
import type { GLDefaultTextData } from "../text/default-text-data.js";
import type { GLTextLayoutOptions } from "../text/layout.js";
import type { GLTextLayer, GLTextLayerOptions, GLTextRenderer, GLTextRendererOptions } from "../text/text-renderer.js";

export type { GLGlyphStorage, GLCurveSetId, GLQuadCurve, GLGlyphBounds, GLGlyphCurves } from "../text/glyph-storage.js";
export type { GLTextData, GLPlacedGlyph, GLGlyphRun, GLTextDataUpdate } from "../text/text-data.js";
export type { GLDefaultTextData } from "../text/default-text-data.js";
export type { GLTextLayer, GLTextLayerOptions, GLTextRenderer, GLTextRendererOptions } from "../text/text-renderer.js";

function unsupported(fn: string): never {
    throw new Error(`lite-gl: ${fn} is not supported on Babylon Native (no Slug text rendering; check engine.caps.textRendering)`);
}

/**
 * Create a glyph storage. NATIVE DIVERGENCE: always throws (see module doc).
 * @param initial - Unused on Native.
 * @returns Never returns.
 */
export function createGlyphStorage(initial?: Map<GLCurveSetId, Map<number, GLGlyphCurves>>): GLGlyphStorage {
    void initial;
    return unsupported("createGlyphStorage");
}

/**
 * Add curves to a glyph storage. NATIVE DIVERGENCE: always throws.
 * @param storage - Unused on Native.
 * @param curveSetId - Unused on Native.
 * @param curves - Unused on Native.
 */
export function updateGlyphStorage(storage: GLGlyphStorage, curveSetId: GLCurveSetId, curves: ReadonlyMap<number, GLGlyphCurves>): void {
    void storage;
    void curveSetId;
    void curves;
    unsupported("updateGlyphStorage");
}

/**
 * Dispose a glyph storage. NATIVE: no-op (none can be created).
 * @param storage - Ignored.
 */
export function disposeGlyphStorage(storage: GLGlyphStorage): void {
    void storage;
}

/**
 * Create text data. NATIVE DIVERGENCE: always throws.
 * @param storage - Unused on Native.
 * @param runs - Unused on Native.
 * @returns Never returns.
 */
export function createTextData(storage: GLGlyphStorage, runs?: readonly GLGlyphRun[]): GLTextData {
    void storage;
    void runs;
    return unsupported("createTextData");
}

/**
 * Update text data. NATIVE DIVERGENCE: always throws.
 * @param data - Unused on Native.
 * @param update - Unused on Native.
 */
export function updateTextData(data: GLTextData, update: GLTextDataUpdate): void {
    void data;
    void update;
    unsupported("updateTextData");
}

/**
 * Dispose text data. NATIVE: no-op (none can be created).
 * @param data - Ignored.
 */
export function disposeTextData(data: GLTextData): void {
    void data;
}

/**
 * Create default (laid-out) text data. NATIVE DIVERGENCE: always throws.
 * @param font - Unused on Native.
 * @param fontSizePx - Unused on Native.
 * @param text - Unused on Native.
 * @param textColor - Unused on Native.
 * @param options - Unused on Native.
 * @returns Never returns.
 */
export function createDefaultTextData(
    font: GLFont,
    fontSizePx: number,
    text: string,
    textColor?: readonly [number, number, number, number],
    options?: GLTextLayoutOptions
): GLDefaultTextData {
    void font;
    void fontSizePx;
    void text;
    void textColor;
    void options;
    return unsupported("createDefaultTextData");
}

/**
 * Replace the text of default text data. NATIVE DIVERGENCE: always throws.
 * @param data - Unused on Native.
 * @param text - Unused on Native.
 * @param textColor - Unused on Native.
 */
export function updateDefaultTextData(data: GLDefaultTextData, text: string, textColor?: readonly [number, number, number, number]): void {
    void data;
    void text;
    void textColor;
    unsupported("updateDefaultTextData");
}

/**
 * Dispose default text data. NATIVE: no-op (none can be created).
 * @param data - Ignored.
 */
export function disposeDefaultTextData(data: GLDefaultTextData): void {
    void data;
}

/**
 * Set the font-weight offset of a run. NATIVE DIVERGENCE: always throws.
 * @param data - Unused on Native.
 * @param run - Unused on Native.
 * @param offset - Unused on Native.
 */
export function setFontWeightOffset(data: GLTextData, run: GLGlyphRun | number, offset: number): void {
    void data;
    void run;
    void offset;
    unsupported("setFontWeightOffset");
}

/**
 * Create a text layer (plain object; identical to the WebGL helper).
 * @param data - The text data the layer draws.
 * @param options - Initial transform / appearance.
 * @returns The new layer.
 */
export function createTextLayer(data: GLTextData, options?: GLTextLayerOptions): GLTextLayer {
    return {
        data,
        positionPx: { x: options?.positionPx?.x ?? 0, y: options?.positionPx?.y ?? 0 },
        rotationRad: options?.rotationRad ?? 0,
        scale: options?.scale ?? 1,
        order: options?.order ?? 0,
        opacity: options?.opacity ?? 1,
        coverageGamma: options?.coverageGamma ?? 1,
        visible: options?.visible ?? true,
    };
}

/**
 * Move a text layer (identical to the WebGL helper).
 * @param layer - The layer.
 * @param x - X position in pixels.
 * @param y - Y position in pixels.
 */
export function setTextLayerPosition(layer: GLTextLayer, x: number, y: number): void {
    layer.positionPx.x = x;
    layer.positionPx.y = y;
}

/**
 * Create a text renderer. NATIVE DIVERGENCE: always throws.
 * @param engine - Unused on Native.
 * @param options - Unused on Native.
 * @returns Never returns.
 */
export function createTextRenderer(engine: GLEngineContext, options: GLTextRendererOptions): GLTextRenderer {
    void engine;
    void options;
    return unsupported("createTextRenderer");
}

/**
 * NATIVE: always `false` (no text renderer can exist).
 * @param renderer - Ignored.
 * @returns `false`.
 */
export function isTextRendererReady(renderer: GLTextRenderer): boolean {
    void renderer;
    return false;
}

/**
 * Render text. NATIVE DIVERGENCE: always throws.
 * @param renderer - Unused on Native.
 * @returns Never returns.
 */
export function renderText(renderer: GLTextRenderer): number {
    void renderer;
    return unsupported("renderText");
}

/**
 * Add a layer to a text renderer. NATIVE DIVERGENCE: always throws.
 * @param renderer - Unused on Native.
 * @param layer - Unused on Native.
 */
export function addTextRendererLayer(renderer: GLTextRenderer, layer: GLTextLayer): void {
    void renderer;
    void layer;
    unsupported("addTextRendererLayer");
}

/**
 * NATIVE: always `false` (no layer can have been added).
 * @param renderer - Ignored.
 * @param layer - Ignored.
 * @returns `false`.
 */
export function removeTextRendererLayer(renderer: GLTextRenderer, layer: GLTextLayer): boolean {
    void renderer;
    void layer;
    return false;
}

/**
 * Register a text renderer with the render loop. NATIVE DIVERGENCE: always throws.
 * @param renderer - Unused on Native.
 */
export function registerTextRenderer(renderer: GLTextRenderer): void {
    void renderer;
    unsupported("registerTextRenderer");
}

/**
 * NATIVE: no-op (nothing can be registered).
 * @param renderer - Ignored.
 */
export function unregisterTextRenderer(renderer: GLTextRenderer): void {
    void renderer;
}

/**
 * NATIVE: no-op (none can be created).
 * @param renderer - Ignored.
 */
export function disposeTextRenderer(renderer: GLTextRenderer): void {
    void renderer;
}
