/**
 * Experimental, temporary Babylon Native backend for evaluation.
 * Its API and implementation may change, be replaced, or be removed.
 *
 * It follows the web Lite GL names and signatures for the composition subset it implements.
 *
 * @experimental
 * @packageDocumentation
 */
export { createNativeEngine, disposeNativeEngine, beginFrame, endFrame, getRenderWidth, getRenderHeight, getCurrentRenderTarget } from "./context.js";
export type { GLEngineCaps, GLEngineContext } from "./context.js";
export {
    createEffect,
    useEffect,
    isEffectReady,
    getEffectCompilationError,
    disposeEffect,
    setEffectFloat,
    setEffectFloat2,
    setEffectFloat3,
    setEffectFloat4,
    setEffectInt,
    setEffectMatrix,
    setEffectFloatArray,
    setEffectFloatArray2,
    setEffectFloatArray3,
    setEffectFloatArray4,
    setEffectTexture,
} from "./effect.js";
export type { GLEffect, GLEffectOptions } from "./effect.js";
export { createVertexBuffer, createIndexBuffer, createMeshVao, bindMeshVao, drawMesh, disposeBuffer, disposeMeshVao } from "./mesh.js";
export type { GLVertexBuffer, GLIndexBuffer, GLAttributeDescriptor, GLMeshVertexBuffer, GLMeshVao } from "./mesh.js";
export { wrapNativeTexture, createRawTexture, disposeTexture } from "./texture.js";
export type { GLTexture, GLTextureOptions, GLRawTextureOptions, NativeTextureHandle } from "./texture.js";
export { createRenderTarget, bindRenderTarget, restoreDefaultFramebuffer, updateWrappedNativeTexture, disposeRenderTarget } from "./render-target.js";
export type { GLRenderTarget, GLRenderTargetOptions } from "./render-target.js";
export { setViewport, setScissor, disableScissor, setBlendMode, clearEngine } from "./state.js";
export type { GLViewport, GLClearOptions, GLBlendMode } from "./state.js";
