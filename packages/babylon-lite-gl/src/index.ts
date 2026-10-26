// @babylonjs/lite-gl — Public API
// Function-based, tree-shakeable WebGL2 micro-engine. Import only what you use.
//
// Convention (mirrors @babylonjs/lite): the public API is re-exported EXPLICITLY
// by name — never `export *`. This keeps the public surface intentional and
// reviewable, lets `export type` mark type-only re-exports (required under
// `isolatedModules`), and keeps internal helpers (e.g. `bindTextureRaw`,
// `bindTextureForUpload`) out of consumers' bundles + `.d.ts`.
//
// The package is `sideEffects: false` and no module has top-level side effects,
// so a consumer that imports only the symbols it needs tree-shakes everything
// else (sprites, html-texture, …) away.

// ─── Engine / context ────────────────────────────────────────────────
export {
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
} from "./context.js";
export type { GLEngineOptions, GLEngineCaps, GLEngineContext } from "./context.js";

// ─── Alpha-to-coverage (optional) ───────────────────────────────────
export { getAlphaToCoverage, getCurrentSampleCount, setAlphaToCoverage } from "./alpha-to-coverage.js";

// ─── Render loop ─────────────────────────────────────────────────────
export { runRenderLoop, stopRenderLoop, beginFrame, endFrame } from "./render-loop.js";

// ─── GPU frame timing (optional) ────────────────────────────────────
export { captureGPUFrameTime, getGPUFrameTimeCounter } from "./gpu-frame-time.js";
export type { GLPerfCounter } from "./gpu-frame-time.js";

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
} from "./effect.js";
export type { GLEffectOptions, GLEffect } from "./effect.js";
export { waitForEffect } from "./effect-ready.js";
export type { GLEffectWaitOptions } from "./effect-ready.js";

// ─── Effect renderer (fullscreen quad) ───────────────────────────────
export { createEffectWrapper, applyEffectWrapper, drawEffect, setViewport, disposeEffectWrapper } from "./effect-renderer.js";
export type { GLEffectWrapperOptions, GLEffectWrapper, GLViewport } from "./effect-renderer.js";

// ─── Textures ────────────────────────────────────────────────────────
export {
    createRawTexture,
    createFloatTexture,
    generateTextureMipMaps,
    loadTexture2D,
    bindTexture,
    disposeTexture,
    updateRawTexture,
    updateTextureSamplingMode,
    updateTextureWrapMode,
    createTextureFromHandle,
    getSamplingModeFilters,
    isTextureReady,
    // GLSamplingMode is a const + same-name type; one value re-export carries both.
    GLSamplingMode,
} from "./texture.js";
export type { GLTextureOptions, GLTextureUpdateOptions, GLFloatTextureOptions, GLTexture, GLSamplingFilters } from "./texture.js";
export { createTextureFromSource } from "./texture-source.js";
export type { GLTextureSourceOptions } from "./texture-source.js";
export {
    createTexture3DFromPixels,
    bindTexture3D,
    setEffectTexture3D,
    generateTexture3DMipMaps,
    updateTexture3DSamplingMode,
    updateTexture3DWrapMode,
    disposeTexture3D,
} from "./texture-3d.js";
export type { GLPixelsTexture3DOptions, GLTexture3D } from "./texture-3d.js";

// ─── Dynamic textures ────────────────────────────────────────────────
export { createDynamicTexture, updateDynamicTexture, clearDynamicTextureSource } from "./dynamic-texture.js";

// ─── Render targets ──────────────────────────────────────────────────
export {
    createRenderTarget,
    createFloatRenderTarget,
    bindRenderTarget,
    generateRenderTargetMipMaps,
    resizeRenderTarget,
    readRenderTargetPixels,
    disposeRenderTarget,
} from "./render-target.js";
export type { GLRenderTarget, GLRenderTargetOptions, GLFloatRenderTargetOptions } from "./render-target.js";

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
} from "./mesh.js";
export type { GLVertexBuffer, GLIndexBuffer, GLAttributeDescriptor, GLMeshVertexBuffer, GLMeshVao } from "./mesh.js";

// ─── Blend modes ─────────────────────────────────────────────────────
// GLBlendMode / GLBlendEquation are const + same-name type; one value
// re-export carries both.
export { GLBlendMode, GLBlendEquation, setBlendMode, setBlendState, disableBlend } from "./blend.js";
export type { GLBlendState } from "./blend.js";

// ─── Depth / stencil / color-mask / clear ────────────────────────────
export { setDepthState, setCullState, setStencilState, setStencilOpSeparate, setColorMask, clearEngine, generateRenderTargetStencil } from "./depth-stencil.js";
export type { GLDepthState, GLStencilState, GLStencilOpState, GLClearOptions } from "./depth-stencil.js";

// ─── Scissor ─────────────────────────────────────────────────────────
export { setScissor, disableScissor } from "./scissor.js";

// ─── Sprites ─────────────────────────────────────────────────────────
export { createSpriteRenderer, renderSprites, setSpriteRendererTexture, disposeSpriteRenderer } from "./sprites.js";
export type { GLSprite, GLSpriteColor, GLSpriteRendererOptions, GLSpriteRenderer } from "./sprites.js";

// ─── HTML-element textures ───────────────────────────────────────────
export { createHtmlElementTexture, updateHtmlElementTexture } from "./html-texture.js";

// ─── Text (analytic Slug coverage) ───────────────────────────────────
export type { GLFont } from "./text/font.js";
export { loadFont, createFontFromBuffer } from "./text/font.js";
export { extractGlyphCurves, cubicToQuadratics } from "./text/glyph-extraction.js";
export type { GLTextLayoutOptions } from "./text/layout.js";
export type { GLGlyphStorage, GLCurveSetId, GLQuadCurve, GLGlyphBounds, GLGlyphCurves } from "./text/glyph-storage.js";
export { createGlyphStorage, updateGlyphStorage, disposeGlyphStorage } from "./text/glyph-storage.js";
export type { GLTextData, GLPlacedGlyph, GLGlyphRun, GLTextDataUpdate } from "./text/text-data.js";
export { createTextData, updateTextData, disposeTextData } from "./text/text-data.js";
export type { GLDefaultTextData } from "./text/default-text-data.js";
export { createDefaultTextData, updateDefaultTextData, disposeDefaultTextData } from "./text/default-text-data.js";
export type { GLTextLayer, GLTextLayerOptions, GLTextRenderer, GLTextRendererOptions } from "./text/text-renderer.js";
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
} from "./text/text-renderer.js";
export { setFontWeightOffset } from "./text/set-font-weight-offset.js";
