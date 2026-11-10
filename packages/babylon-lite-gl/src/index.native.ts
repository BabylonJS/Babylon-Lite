// @babylonjs/lite-gl/native — Public API of the Babylon Native backend.
//
// PARITY: this barrel exports EVERY value and type name of the WebGL barrel
// (src/index.ts), in the same order and with the same receiver-first call
// signatures, so consumer code is source-compatible. A Babylon Native app imports
// `@babylonjs/lite-gl/native` (or resolves `.` with the `babylon-native`
// condition) and calls `createGLEngine(null)` (or `createNativeGLEngine()`).
// Features Babylon Native cannot back (3D textures, alpha-to-coverage, GPU frame
// timing, two-sided stencil, Slug text rendering, the rendering canvas) keep the
// same names/signatures as DECLARED DIVERGENCES — a `caps` flag reports `false`,
// queries return neutral values and feature calls throw
// `lite-gl: <fn> is not supported on Babylon Native` (safe disables no-op). See
// docs/gl/architecture/03-native-backend.md for the full classification.
//
// Native-only extras (allow-listed by tests/gl/unit/native-parity.test.ts):
// `createNativeGLEngine`, `disposeNativeGLEngine` and the `Native*Source` types.
//
// Pure, backend-agnostic WebGL modules (sampling-mode helpers, text font / glyph
// extraction) are re-exported directly; they contain no WebGL or DOM code.
//
// The package is `sideEffects: false`; consumers tree-shake unused modules.

// ─── Engine / context ────────────────────────────────────────────────
export {
    // Native-only extras (allow-listed in the parity test): explicit native
    // factory/disposer. `createGLEngine(null)` is the portable spelling.
    createNativeGLEngine,
    disposeNativeGLEngine,
    createGLEngine,
    disposeGLEngine,
    resizeGLEngine,
    setGLEngineSize,
    wipeGLStateCache,
    getRenderWidth,
    getRenderHeight,
    getHardwareScalingLevel,
    setHardwareScalingLevel,
    getRenderingCanvas,
    onContextLost,
    offContextLost,
    onContextRestored,
    offContextRestored,
} from "./native/native-context.js";
export type { GLEngineOptions, GLEngineCaps, GLEngineContext } from "./native/native-context.js";

// ─── Alpha-to-coverage (DIVERGENCE: caps.alphaToCoverage false) ───────────────────────────────────
export { getAlphaToCoverage, getCurrentSampleCount, setAlphaToCoverage } from "./native/alpha-to-coverage.js";

// ─── Render loop ─────────────────────────────────────────────────────
export { runRenderLoop, stopRenderLoop, beginFrame, endFrame } from "./native/render-loop.js";

// ─── GPU frame timing (DIVERGENCE: caps.gpuFrameTime false) ────────────────────────────────────
export { captureGPUFrameTime, getGPUFrameTimeCounter } from "./native/gpu-frame-time.js";
export type { GLPerfCounter } from "./native/gpu-frame-time.js";

// ─── Effects ─────────────────────────────────────────────────────────
export {
    createEffect,
    useEffect,
    isEffectReady,
    getEffectCompilationError,
    executeWhenCompiled,
    disposeEffect,
    setEffectFloat,
    setEffectFloat2,
    setEffectFloat3,
    setEffectFloat4,
    setEffectColor3,
    setEffectColor4,
    setEffectVector2,
    setEffectDirectColor4,
    setEffectInt,
    setEffectTexture,
    setEffectMatrix,
    setEffectMatrix3x3,
    setEffectFloatArray,
    setEffectFloatArray4,
    setEffectIntArray,
} from "./native/effect.js";
export type { GLEffectOptions, GLEffect } from "./native/effect.js";
export { waitForEffect } from "./native/effect-ready.js";
export type { GLEffectWaitOptions } from "./native/effect-ready.js";

// ─── Effect renderer (fullscreen quad) ───────────────────────────────
export { createEffectWrapper, applyEffectWrapper, drawEffect, setViewport, disposeEffectWrapper } from "./native/effect-renderer.js";
export type { GLEffectWrapperOptions, GLEffectWrapper, GLViewport } from "./native/effect-renderer.js";

// ─── Textures ────────────────────────────────────────────────────────
export {
    createRawTexture,
    createFloatTexture,
    generateTextureMipMaps,
    loadTexture2D,
    bindTexture,
    unbindTexture,
    disposeTexture,
    updateRawTexture,
    updateTextureSamplingMode,
    updateTextureSamplingPreset,
    updateTextureWrapMode,
    createTextureFromHandle,
    getSamplingModeFilters,
    isTextureReady,
    // GLSamplingMode is a const + same-name type; one value re-export carries both.
    GLSamplingMode,
} from "./native/texture.js";
export type { GLTextureOptions, GLTextureUpdateOptions, GLRawTextureOptions, GLFloatTextureOptions, GLTexture, GLSamplingFilters } from "./native/texture.js";
export { createTextureFromSource } from "./native/texture-source.js";
export type { GLTextureSourceOptions } from "./native/texture-source.js";
export {
    createTexture3DFromPixels,
    bindTexture3D,
    unbindTexture3D,
    setEffectTexture3D,
    generateTexture3DMipMaps,
    updateTexture3DSamplingMode,
    updateTexture3DWrapMode,
    disposeTexture3D,
} from "./native/texture-3d.js";
export type { GLPixelsTexture3DOptions, GLTexture3D } from "./native/texture-3d.js";
// Native-only source types accepted by createTextureFromSource / dynamic / html textures.
export type { NativeCanvasSource, NativePixelSource, NativeTextureSource } from "./native/native-source.js";

// ─── Dynamic textures ────────────────────────────────────────────────
export { createDynamicTexture, updateDynamicTexture, clearDynamicTextureSource } from "./native/dynamic-texture.js";

// ─── Render targets ──────────────────────────────────────────────────
export {
    createRenderTarget,
    createFloatRenderTarget,
    bindRenderTarget,
    restoreDefaultFramebuffer,
    generateRenderTargetMipMaps,
    resizeRenderTarget,
    readRenderTargetPixels,
    readRenderTargetPixelsToBuffer,
    disposeRenderTarget,
} from "./native/render-target.js";
export type {
    GLRenderTarget,
    GLRenderTargetOptions,
    GLFloatRenderTargetOptions,
    GLReadPixelsRegionOptions,
    GLReadPixelsOptions,
    GLReadPixelsToBufferOptions,
} from "./native/render-target.js";

// ─── Meshes / buffers / instancing ───────────────────────────────────
export {
    createVertexBuffer,
    updateVertexBuffer,
    createIndexBuffer,
    disposeBuffer,
    bindIndexBuffer,
    bindAttributes,
    unbindInstanceAttributes,
    drawIndexed,
    createMeshVao,
    bindMeshVao,
    drawMesh,
    disposeMeshVao,
} from "./native/mesh.js";
export type { GLVertexBuffer, GLIndexBuffer, GLAttributeDescriptor, GLMeshVertexBuffer, GLMeshVao } from "./native/mesh.js";

// ─── Blend modes ─────────────────────────────────────────────────────
// GLBlendMode / GLBlendEquation are const + same-name type; one value
// re-export carries both.
export { GLBlendMode, GLBlendEquation, setBlendMode, setBlendState, disableBlend } from "./native/blend.js";
export type { GLBlendState } from "./native/blend.js";

// ─── Depth / stencil / color-mask / clear ────────────────────────────
export { setDepthState, setCullState, setStencilState, setStencilOpSeparate, setColorMask, clearEngine, generateRenderTargetStencil } from "./native/depth-stencil.js";
export type { GLDepthState, GLStencilState, GLStencilOpState, GLClearOptions } from "./native/depth-stencil.js";

// ─── Scissor ─────────────────────────────────────────────────────────
export { setScissor, disableScissor } from "./native/scissor.js";

// ─── Sprites ─────────────────────────────────────────────────────────
export { createSpriteRenderer, renderSprites, setSpriteRendererTexture, disposeSpriteRenderer } from "./native/sprites.js";
export type { GLSprite, GLSpriteColor, GLSpriteRendererOptions, GLSpriteRenderer } from "./native/sprites.js";

// ─── HTML-element textures ───────────────────────────────────────────
export { createHtmlElementTexture, updateHtmlElementTexture } from "./native/html-texture.js";

// ─── Text (font helpers shared; renderer is a DIVERGENCE: caps.textRendering false) ───────────────────────────────────
export type { GLFont } from "./text/font.js";
export { loadFont, createFontFromBuffer } from "./text/font.js";
export { extractGlyphCurves, cubicToQuadratics } from "./text/glyph-extraction.js";
export type { GLTextLayoutOptions } from "./text/layout.js";
export type { GLGlyphStorage, GLCurveSetId, GLQuadCurve, GLGlyphBounds, GLGlyphCurves } from "./native/text.js";
export { createGlyphStorage, updateGlyphStorage, disposeGlyphStorage } from "./native/text.js";
export type { GLTextData, GLPlacedGlyph, GLGlyphRun, GLTextDataUpdate } from "./native/text.js";
export { createTextData, updateTextData, disposeTextData } from "./native/text.js";
export type { GLDefaultTextData } from "./native/text.js";
export { createDefaultTextData, updateDefaultTextData, disposeDefaultTextData } from "./native/text.js";
export type { GLTextLayer, GLTextLayerOptions, GLTextRenderer, GLTextRendererOptions } from "./native/text.js";
export {
    createTextLayer,
    setTextLayerPosition,
    createTextRenderer,
    renderText,
    isTextRendererReady,
    addTextRendererLayer,
    removeTextRendererLayer,
    registerTextRenderer,
    unregisterTextRenderer,
    disposeTextRenderer,
} from "./native/text.js";
export { setFontWeightOffset } from "./native/text.js";
