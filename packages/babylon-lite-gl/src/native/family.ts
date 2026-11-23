import type { GLFamily } from "../family.js";
import type { GLEngineContext, createNativeEngine, disposeNativeEngine } from "./context.js";
import type { GLEffect } from "./effect.js";
import type { GLAttributeDescriptor, GLIndexBuffer, GLMeshVao, GLVertexBuffer } from "./mesh.js";
import type { GLRenderTarget, GLRenderTargetOptions, updateWrappedNativeTexture } from "./render-target.js";
import type { GLBlendMode } from "./state.js";
import type { GLRawTextureOptions, GLTexture, GLTextureOptions, wrapNativeTexture } from "./texture.js";

/**
 * The Babylon Native backend's types for the backend-neutral contract.
 *
 * Slots of features this backend does not implement are `never`, so their
 * operations cannot be satisfied by native functions.
 */
export interface NativeGLFamily extends GLFamily {
    readonly engine: GLEngineContext;
    readonly effect: GLEffect;
    readonly effectWrapper: never;
    readonly texture: GLTexture;
    readonly texture3D: never;
    readonly renderTarget: GLRenderTarget;
    readonly vertexBuffer: GLVertexBuffer;
    readonly indexBuffer: GLIndexBuffer;
    readonly meshVao: GLMeshVao;
    readonly spriteRenderer: never;
    readonly font: never;
    readonly glyphStorage: never;
    readonly textData: never;
    readonly defaultTextData: never;
    readonly textLayer: never;
    readonly textRenderer: never;
    readonly perfCounter: never;
    /** Native samplers always sample a texture. */
    readonly noTexture: never;
    /** Native draws are non-instanced. */
    readonly instanceCount: 0;
    /** Native vertex buffers are immutable, so creation takes only the data. */
    readonly vertexBufferArgs: [];
    readonly floatArray: ArrayLike<number>;
    /** Native raw uploads take RGBA8 bytes. */
    readonly rawTextureData: Uint8Array;
    readonly rawTextureOptions: GLRawTextureOptions;
    readonly textureOptions: GLTextureOptions;
    readonly renderTargetOptions: GLRenderTargetOptions;
    readonly attributeDescriptor: GLAttributeDescriptor;
    readonly blendMode: GLBlendMode;
    readonly effectWaitOptions: never;
    readonly effectWrapperOptions: never;
    readonly textureUpdateOptions: never;
    readonly floatTextureOptions: never;
    readonly samplingMode: never;
    readonly samplingFilters: never;
    readonly texture3DOptions: never;
    readonly floatRenderTargetOptions: never;
    readonly readPixelsOptions: never;
    readonly blendState: never;
    readonly depthState: never;
    readonly stencilState: never;
    readonly stencilOpState: never;
    readonly spriteRendererOptions: never;
    readonly sprite: never;
    readonly glyphCurves: never;
    readonly quadCurve: never;
    readonly glyphRun: never;
    readonly textDataUpdate: never;
    readonly textLayoutOptions: never;
    readonly textLayerOptions: never;
    readonly textRendererOptions: never;
}

/** Native operations that create or destroy an engine or exchange data with native texture storage. */
export interface NativeGLHostOps {
    readonly createNativeEngine: typeof createNativeEngine;
    readonly disposeNativeEngine: typeof disposeNativeEngine;
    readonly wrapNativeTexture: typeof wrapNativeTexture;
    readonly updateWrappedNativeTexture: typeof updateWrappedNativeTexture;
}
