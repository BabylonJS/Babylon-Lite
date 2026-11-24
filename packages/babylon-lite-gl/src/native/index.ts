/**
 * Experimental, temporary Babylon Native backend for evaluation.
 * Its API and implementation may change, be replaced, or be removed.
 *
 * It implements a subset of the backend-neutral contract in
 * `@babylonjs/lite-gl/family`, described by {@link NativeGLFamily}, plus the
 * native host operations in {@link NativeGLHostOps}.
 *
 * @experimental
 * @packageDocumentation
 */
export type { GLEffectOptions, GLViewport, GLClearOptions } from "../family.js";
export type { NativeGLFamily, NativeGLHostOps } from "./family.js";
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
export type { GLEffect } from "./effect.js";
export { createVertexBuffer, createIndexBuffer, createMeshVao, bindMeshVao, drawMesh, disposeBuffer, disposeMeshVao } from "./mesh.js";
export type { GLVertexBuffer, GLIndexBuffer, GLAttributeDescriptor, GLMeshVertexBuffer, GLMeshVao } from "./mesh.js";
export { wrapNativeTexture, createRawTexture, disposeTexture } from "./texture.js";
export type { GLTexture, GLTextureOptions, GLRawTextureOptions, NativeTextureHandle } from "./texture.js";
export { createRenderTarget, bindRenderTarget, restoreDefaultFramebuffer, updateWrappedNativeTexture, disposeRenderTarget } from "./render-target.js";
export type { GLRenderTarget, GLRenderTargetOptions } from "./render-target.js";
export { setViewport, setScissor, disableScissor, setBlendMode, clearEngine } from "./state.js";
export type { GLBlendMode } from "./state.js";
