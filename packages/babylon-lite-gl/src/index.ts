// @babylonjs/lite-gl — Public API
// Function-based, tree-shakeable WebGL2 micro-engine. Import only what you use.
//
// Convention (mirrors @babylonjs/lite): the public API is re-exported EXPLICITLY
// by name — never `export *`. This keeps the public surface intentional and
// reviewable, lets `export type` mark type-only re-exports (required under
// `isolatedModules`), and keeps internal helpers (e.g. `bindTextureRaw`,
// `bindTextureForUpload`) out of consumers' bundles + `.d.ts`.
//
// The `/sprites` and `/html-texture` features are re-exported here AND kept as
// dedicated sub-entries (`@babylonjs/lite-gl/sprites`, `.../html-texture`). The
// package is `sideEffects: false` and these modules have no top-level side
// effects, so a consumer that imports only core symbols tree-shakes the sprite /
// html-texture code away regardless of which path it imports from.

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

// ─── Render loop ─────────────────────────────────────────────────────
export { runRenderLoop, stopRenderLoop } from "./render-loop.js";

// ─── Effects ─────────────────────────────────────────────────────────
export {
    createEffect,
    useEffect,
    isEffectReady,
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
} from "./texture.js";
export type { GLTextureOptions, GLFloatTextureOptions, GLTexture } from "./texture.js";

// ─── Dynamic textures (also at `@babylonjs/lite-gl/dynamic-texture`) ──
export { createDynamicTexture, updateDynamicTexture, clearDynamicTextureSource } from "./dynamic-texture.js";

// ─── Render targets (also at `@babylonjs/lite-gl/render-target`) ─────
export {
    createRenderTarget,
    createFloatRenderTarget,
    bindRenderTarget,
    generateRenderTargetMipMaps,
    resizeRenderTarget,
    readRenderTargetPixels,
    disposeRenderTarget,
    createPingPong,
    resizePingPong,
    disposePingPong,
} from "./render-target.js";
export type { GLRenderTarget, GLRenderTargetOptions, GLFloatRenderTargetOptions, GLPingPong } from "./render-target.js";

// ─── Meshes / buffers / instancing (also at `@babylonjs/lite-gl/mesh`) ──
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
export { setDepthState, setCullState, setStencilState, setColorMask, clearEngine, generateRenderTargetStencil } from "./depth-stencil.js";
export type { GLDepthState, GLStencilState, GLClearOptions } from "./depth-stencil.js";

// ─── Scissor ─────────────────────────────────────────────────────────
export { setScissor, disableScissor } from "./scissor.js";

// ─── Sprites (also at `@babylonjs/lite-gl/sprites`) ──────────────────
export { createSpriteRenderer, renderSprites, setSpriteRendererTexture, disposeSpriteRenderer } from "./sprites.js";
export type { GLSprite, GLSpriteColor, GLSpriteRendererOptions, GLSpriteRenderer } from "./sprites.js";

// ─── HTML-element textures (also at `@babylonjs/lite-gl/html-texture`) ──
// GLSamplingMode is a const + same-name type; one value re-export carries both.
export { createHtmlElementTexture, updateHtmlElementTexture, GLSamplingMode } from "./html-texture.js";
export type { GLHtmlElementTextureOptions } from "./html-texture.js";
