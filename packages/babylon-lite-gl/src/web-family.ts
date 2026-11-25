import type { GLBlendMode, GLBlendState } from "./blend.js";
import type { GLEngineContext, createGLEngine, createHostOwnedGLEngine, disposeGLEngine, getRenderingCanvas } from "./context.js";
import type { GLDepthState, GLStencilOpState, GLStencilState } from "./depth-stencil.js";
import type { clearDynamicTextureSource, updateDynamicTexture } from "./dynamic-texture.js";
import type { GLEffect } from "./effect.js";
import type { GLEffectWaitOptions } from "./effect-ready.js";
import type { GLEffectWrapper, GLEffectWrapperOptions } from "./effect-renderer.js";
import type { GLFamily } from "./family.js";
import type { GLPerfCounter } from "./gpu-frame-time.js";
import type { createHtmlElementTexture, updateHtmlElementTexture } from "./html-texture.js";
import type { GLAttributeDescriptor, GLIndexBuffer, GLMeshVao, GLVertexBuffer } from "./mesh.js";
import type { GLFloatRenderTargetOptions, GLReadPixelsOptions, GLRenderTarget, GLRenderTargetOptions, readRenderTargetPixelsToBuffer } from "./render-target.js";
import type { GLSprite, GLSpriteRenderer, GLSpriteRendererOptions } from "./sprites.js";
import type { GLDefaultTextData } from "./text/default-text-data.js";
import type { GLFont } from "./text/font.js";
import type { GLGlyphCurves, GLGlyphStorage, GLQuadCurve } from "./text/glyph-storage.js";
import type { GLTextLayoutOptions } from "./text/layout.js";
import type { GLGlyphRun, GLTextData, GLTextDataUpdate } from "./text/text-data.js";
import type { GLTextLayer, GLTextLayerOptions, GLTextRenderer, GLTextRendererOptions } from "./text/text-renderer.js";
import type {
    GLFloatTextureOptions,
    GLRawTextureOptions,
    GLSamplingFilters,
    GLSamplingMode,
    GLTexture,
    GLTextureOptions,
    GLTextureUpdateOptions,
    createTextureFromHandle,
} from "./texture.js";
import type { GLPixelsTexture3DOptions, GLTexture3D } from "./texture-3d.js";
import type { createTextureFromSource } from "./texture-source.js";

/** The WebGL2 backend's types for the backend-neutral contract. */
export interface WebGLFamily extends GLFamily {
    readonly engine: GLEngineContext;
    readonly effect: GLEffect;
    readonly effectWrapper: GLEffectWrapper;
    readonly texture: GLTexture;
    readonly texture3D: GLTexture3D;
    readonly renderTarget: GLRenderTarget;
    readonly vertexBuffer: GLVertexBuffer;
    readonly indexBuffer: GLIndexBuffer;
    readonly meshVao: GLMeshVao;
    readonly spriteRenderer: GLSpriteRenderer;
    readonly font: GLFont;
    readonly glyphStorage: GLGlyphStorage;
    readonly textData: GLTextData;
    readonly defaultTextData: GLDefaultTextData;
    readonly textLayer: GLTextLayer;
    readonly textRenderer: GLTextRenderer;
    readonly perfCounter: GLPerfCounter;
    readonly noTexture: null;
    readonly instanceCount: number;
    readonly vertexBufferArgs: [dynamic?: boolean];
    readonly floatArray: Float32Array | number[];
    readonly rawTextureData: ArrayBufferView | null;
    readonly rawTextureOptions: GLRawTextureOptions;
    readonly textureOptions: GLTextureOptions;
    readonly renderTargetOptions: GLRenderTargetOptions;
    readonly attributeDescriptor: GLAttributeDescriptor;
    readonly blendMode: GLBlendMode;
    readonly effectWaitOptions: GLEffectWaitOptions;
    readonly effectWrapperOptions: GLEffectWrapperOptions;
    readonly textureUpdateOptions: GLTextureUpdateOptions;
    readonly floatTextureOptions: GLFloatTextureOptions;
    readonly samplingMode: GLSamplingMode;
    readonly samplingFilters: GLSamplingFilters;
    readonly texture3DOptions: GLPixelsTexture3DOptions;
    readonly floatRenderTargetOptions: GLFloatRenderTargetOptions;
    readonly readPixelsOptions: GLReadPixelsOptions;
    readonly blendState: GLBlendState;
    readonly depthState: GLDepthState;
    readonly stencilState: GLStencilState;
    readonly stencilOpState: GLStencilOpState;
    readonly spriteRendererOptions: GLSpriteRendererOptions;
    readonly sprite: GLSprite;
    readonly glyphCurves: GLGlyphCurves;
    readonly quadCurve: GLQuadCurve;
    readonly glyphRun: GLGlyphRun;
    readonly textDataUpdate: GLTextDataUpdate;
    readonly textLayoutOptions: GLTextLayoutOptions;
    readonly textLayerOptions: GLTextLayerOptions;
    readonly textRendererOptions: GLTextRendererOptions;
}

/** WebGL2 operations that create or destroy an engine or exchange data with browser or WebGL objects. */
export interface WebGLHostOps {
    readonly createGLEngine: typeof createGLEngine;
    readonly createHostOwnedGLEngine: typeof createHostOwnedGLEngine;
    readonly disposeGLEngine: typeof disposeGLEngine;
    readonly getRenderingCanvas: typeof getRenderingCanvas;
    readonly createTextureFromHandle: typeof createTextureFromHandle;
    readonly createTextureFromSource: typeof createTextureFromSource;
    readonly updateDynamicTexture: typeof updateDynamicTexture;
    readonly clearDynamicTextureSource: typeof clearDynamicTextureSource;
    readonly createHtmlElementTexture: typeof createHtmlElementTexture;
    readonly updateHtmlElementTexture: typeof updateHtmlElementTexture;
    readonly readRenderTargetPixelsToBuffer: typeof readRenderTargetPixelsToBuffer;
}
