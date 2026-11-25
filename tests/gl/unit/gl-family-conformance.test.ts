// Completeness backstop for the backend-neutral contract in `family.ts`.
//
// Every callable export of each backend entry must be classified exactly once,
// either as a `GLOps` operation or as a backend host operation, and must match
// the contract instantiated with that backend's family exactly. Each entry has a
// complete uber-kit built from explicit references to its exports, so a new,
// removed or re-typed export fails `tsc -p tests/gl/tsconfig.json` (the CI
// "Lint & Type Check" job) until the contract, the host operations and the
// uber-kit are updated together. See packages/babylon-lite-gl/AGENTS.md.

import { describe, expect, it } from "vitest";
import type { GLFamily, GLFamilyPortableValues, GLKit, GLOpName, GLOps } from "../../../packages/babylon-lite-gl/src/family";
import * as Web from "../../../packages/babylon-lite-gl/src/index";
import * as Native from "../../../packages/babylon-lite-gl/src/native/index";

/** Exact type identity, distinguishing optionality, readonly-ness and `any`. */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
/** Names of the function-valued members of a module namespace. */
type CallableKeys<M> = { [K in keyof M]: M[K] extends (...args: never[]) => unknown ? K : never }[keyof M];
/** Shared members whose types differ between the contract `C` and the module `M`. */
type Mismatched<C, M> = { [K in keyof C & keyof M]: Equal<C[K], M[K]> extends true ? never : K }[keyof C & keyof M];

/** Portable values that family `F` does not accept, among the slots it implements. */
type UnacceptedPortableValues<F extends GLFamily> = {
    [K in keyof GLFamilyPortableValues]: [F[K]] extends [never] ? never : GLFamilyPortableValues[K] extends F[K] ? never : K;
}[keyof GLFamilyPortableValues];

/** Fails to compile, naming the offending keys, unless `T` is empty. */
function assertNone<T extends never>(): T | undefined {
    return undefined;
}
/** Fails to compile unless `T` is `true`. */
function assertTrue<T extends true>(): T | undefined {
    return undefined;
}

type WebOps = GLOps<Web.WebGLFamily>;
type WebCallable = CallableKeys<typeof Web>;

// The contract a native kit can hold is exactly the operations the native entry
// exports; operations it does not implement stay outside the kit's type.
type NativeOpName = CallableKeys<typeof Native> & GLOpName;
type NativeOps = Pick<GLOps<Native.NativeGLFamily>, NativeOpName>;
type NativeCallable = CallableKeys<typeof Native>;

const webUberKit: GLKit<Web.WebGLFamily, GLOpName> & Web.WebGLHostOps = {
    // Engine, render loop and frame timing
    createGLEngine: Web.createGLEngine,
    createHostOwnedGLEngine: Web.createHostOwnedGLEngine,
    disposeGLEngine: Web.disposeGLEngine,
    resizeGLEngine: Web.resizeGLEngine,
    setGLEngineSize: Web.setGLEngineSize,
    wipeGLStateCache: Web.wipeGLStateCache,
    getRenderWidth: Web.getRenderWidth,
    getRenderHeight: Web.getRenderHeight,
    getTextureCount: Web.getTextureCount,
    getCurrentRenderTarget: Web.getCurrentRenderTarget,
    getHardwareScalingLevel: Web.getHardwareScalingLevel,
    setHardwareScalingLevel: Web.setHardwareScalingLevel,
    getRenderingCanvas: Web.getRenderingCanvas,
    onContextLost: Web.onContextLost,
    offContextLost: Web.offContextLost,
    onContextRestored: Web.onContextRestored,
    offContextRestored: Web.offContextRestored,
    getAlphaToCoverage: Web.getAlphaToCoverage,
    getCurrentSampleCount: Web.getCurrentSampleCount,
    setAlphaToCoverage: Web.setAlphaToCoverage,
    runRenderLoop: Web.runRenderLoop,
    stopRenderLoop: Web.stopRenderLoop,
    beginFrame: Web.beginFrame,
    endFrame: Web.endFrame,
    captureGPUFrameTime: Web.captureGPUFrameTime,
    getGPUFrameTimeCounter: Web.getGPUFrameTimeCounter,
    setFramebufferValidation: Web.setFramebufferValidation,
    // Effects and the fullscreen effect renderer
    createEffect: Web.createEffect,
    useEffect: Web.useEffect,
    isEffectReady: Web.isEffectReady,
    getEffectCompilationError: Web.getEffectCompilationError,
    executeWhenCompiled: Web.executeWhenCompiled,
    disposeEffect: Web.disposeEffect,
    setEffectFloat: Web.setEffectFloat,
    setEffectFloat2: Web.setEffectFloat2,
    setEffectFloat3: Web.setEffectFloat3,
    setEffectFloat4: Web.setEffectFloat4,
    setEffectColor3: Web.setEffectColor3,
    setEffectColor4: Web.setEffectColor4,
    setEffectVector2: Web.setEffectVector2,
    setEffectDirectColor4: Web.setEffectDirectColor4,
    setEffectInt: Web.setEffectInt,
    setEffectTexture: Web.setEffectTexture,
    setEffectMatrix: Web.setEffectMatrix,
    setEffectMatrix3x3: Web.setEffectMatrix3x3,
    setEffectFloatArray: Web.setEffectFloatArray,
    setEffectFloatArray2: Web.setEffectFloatArray2,
    setEffectFloatArray3: Web.setEffectFloatArray3,
    setEffectFloatArray4: Web.setEffectFloatArray4,
    setEffectIntArray: Web.setEffectIntArray,
    waitForEffect: Web.waitForEffect,
    createEffectWrapper: Web.createEffectWrapper,
    applyEffectWrapper: Web.applyEffectWrapper,
    drawEffect: Web.drawEffect,
    setViewport: Web.setViewport,
    disposeEffectWrapper: Web.disposeEffectWrapper,
    // Textures
    createRawTexture: Web.createRawTexture,
    createFloatTexture: Web.createFloatTexture,
    generateTextureMipMaps: Web.generateTextureMipMaps,
    loadTexture2D: Web.loadTexture2D,
    bindTexture: Web.bindTexture,
    unbindTexture: Web.unbindTexture,
    disposeTexture: Web.disposeTexture,
    updateRawTexture: Web.updateRawTexture,
    updateTextureSamplingMode: Web.updateTextureSamplingMode,
    updateTextureSamplingPreset: Web.updateTextureSamplingPreset,
    updateTextureWrapMode: Web.updateTextureWrapMode,
    createTextureFromHandle: Web.createTextureFromHandle,
    getSamplingModeFilters: Web.getSamplingModeFilters,
    isTextureReady: Web.isTextureReady,
    createTextureFromSource: Web.createTextureFromSource,
    createTexture3DFromPixels: Web.createTexture3DFromPixels,
    bindTexture3D: Web.bindTexture3D,
    unbindTexture3D: Web.unbindTexture3D,
    setEffectTexture3D: Web.setEffectTexture3D,
    generateTexture3DMipMaps: Web.generateTexture3DMipMaps,
    updateTexture3DSamplingMode: Web.updateTexture3DSamplingMode,
    updateTexture3DWrapMode: Web.updateTexture3DWrapMode,
    disposeTexture3D: Web.disposeTexture3D,
    createDynamicTexture: Web.createDynamicTexture,
    updateDynamicTexture: Web.updateDynamicTexture,
    clearDynamicTextureSource: Web.clearDynamicTextureSource,
    createHtmlElementTexture: Web.createHtmlElementTexture,
    updateHtmlElementTexture: Web.updateHtmlElementTexture,
    // Render targets
    createRenderTarget: Web.createRenderTarget,
    createFloatRenderTarget: Web.createFloatRenderTarget,
    bindRenderTarget: Web.bindRenderTarget,
    restoreDefaultFramebuffer: Web.restoreDefaultFramebuffer,
    presentRenderTarget: Web.presentRenderTarget,
    generateRenderTargetMipMaps: Web.generateRenderTargetMipMaps,
    resizeRenderTarget: Web.resizeRenderTarget,
    readRenderTargetPixels: Web.readRenderTargetPixels,
    readRenderTargetPixelsToBuffer: Web.readRenderTargetPixelsToBuffer,
    disposeRenderTarget: Web.disposeRenderTarget,
    // Meshes, buffers and instancing
    createVertexBuffer: Web.createVertexBuffer,
    updateVertexBuffer: Web.updateVertexBuffer,
    createIndexBuffer: Web.createIndexBuffer,
    disposeBuffer: Web.disposeBuffer,
    bindIndexBuffer: Web.bindIndexBuffer,
    bindAttributes: Web.bindAttributes,
    bindAttributesCached: Web.bindAttributesCached,
    disableAttributeByIndex: Web.disableAttributeByIndex,
    unbindAllAttributes: Web.unbindAllAttributes,
    unbindInstanceAttributes: Web.unbindInstanceAttributes,
    drawIndexed: Web.drawIndexed,
    createMeshVao: Web.createMeshVao,
    bindMeshVao: Web.bindMeshVao,
    drawMesh: Web.drawMesh,
    disposeMeshVao: Web.disposeMeshVao,
    // Blend, depth, stencil, color mask, clear and scissor state
    setBlendMode: Web.setBlendMode,
    setBlendState: Web.setBlendState,
    disableBlend: Web.disableBlend,
    setDepthState: Web.setDepthState,
    setCullState: Web.setCullState,
    setStencilState: Web.setStencilState,
    setStencilOpSeparate: Web.setStencilOpSeparate,
    setColorMask: Web.setColorMask,
    clearEngine: Web.clearEngine,
    generateRenderTargetStencil: Web.generateRenderTargetStencil,
    setScissor: Web.setScissor,
    disableScissor: Web.disableScissor,
    // Sprites
    createSpriteRenderer: Web.createSpriteRenderer,
    renderSprites: Web.renderSprites,
    setSpriteRendererTexture: Web.setSpriteRendererTexture,
    disposeSpriteRenderer: Web.disposeSpriteRenderer,
    // Text
    loadFont: Web.loadFont,
    createFontFromBuffer: Web.createFontFromBuffer,
    extractGlyphCurves: Web.extractGlyphCurves,
    cubicToQuadratics: Web.cubicToQuadratics,
    createGlyphStorage: Web.createGlyphStorage,
    updateGlyphStorage: Web.updateGlyphStorage,
    disposeGlyphStorage: Web.disposeGlyphStorage,
    createTextData: Web.createTextData,
    updateTextData: Web.updateTextData,
    disposeTextData: Web.disposeTextData,
    createDefaultTextData: Web.createDefaultTextData,
    updateDefaultTextData: Web.updateDefaultTextData,
    disposeDefaultTextData: Web.disposeDefaultTextData,
    createTextLayer: Web.createTextLayer,
    setTextLayerPosition: Web.setTextLayerPosition,
    createTextRenderer: Web.createTextRenderer,
    renderText: Web.renderText,
    isTextRendererReady: Web.isTextRendererReady,
    addTextRendererLayer: Web.addTextRendererLayer,
    removeTextRendererLayer: Web.removeTextRendererLayer,
    registerTextRenderer: Web.registerTextRenderer,
    unregisterTextRenderer: Web.unregisterTextRenderer,
    disposeTextRenderer: Web.disposeTextRenderer,
    setFontWeightOffset: Web.setFontWeightOffset,
};

const nativeUberKit: GLKit<Native.NativeGLFamily, NativeOpName> & Native.NativeGLHostOps = {
    createNativeEngine: Native.createNativeEngine,
    disposeNativeEngine: Native.disposeNativeEngine,
    beginFrame: Native.beginFrame,
    endFrame: Native.endFrame,
    getRenderWidth: Native.getRenderWidth,
    getRenderHeight: Native.getRenderHeight,
    getCurrentRenderTarget: Native.getCurrentRenderTarget,
    createEffect: Native.createEffect,
    useEffect: Native.useEffect,
    isEffectReady: Native.isEffectReady,
    getEffectCompilationError: Native.getEffectCompilationError,
    disposeEffect: Native.disposeEffect,
    setEffectFloat: Native.setEffectFloat,
    setEffectFloat2: Native.setEffectFloat2,
    setEffectFloat3: Native.setEffectFloat3,
    setEffectFloat4: Native.setEffectFloat4,
    setEffectInt: Native.setEffectInt,
    setEffectMatrix: Native.setEffectMatrix,
    setEffectFloatArray: Native.setEffectFloatArray,
    setEffectFloatArray2: Native.setEffectFloatArray2,
    setEffectFloatArray3: Native.setEffectFloatArray3,
    setEffectFloatArray4: Native.setEffectFloatArray4,
    setEffectTexture: Native.setEffectTexture,
    createVertexBuffer: Native.createVertexBuffer,
    createIndexBuffer: Native.createIndexBuffer,
    createMeshVao: Native.createMeshVao,
    bindMeshVao: Native.bindMeshVao,
    drawMesh: Native.drawMesh,
    disposeBuffer: Native.disposeBuffer,
    disposeMeshVao: Native.disposeMeshVao,
    wrapNativeTexture: Native.wrapNativeTexture,
    createRawTexture: Native.createRawTexture,
    disposeTexture: Native.disposeTexture,
    createRenderTarget: Native.createRenderTarget,
    bindRenderTarget: Native.bindRenderTarget,
    restoreDefaultFramebuffer: Native.restoreDefaultFramebuffer,
    updateWrappedNativeTexture: Native.updateWrappedNativeTexture,
    disposeRenderTarget: Native.disposeRenderTarget,
    setViewport: Native.setViewport,
    setScissor: Native.setScissor,
    disableScissor: Native.disableScissor,
    setBlendMode: Native.setBlendMode,
    clearEngine: Native.clearEngine,
};

function functionExports(module: Record<string, unknown>): string[] {
    return Object.keys(module)
        .filter((name) => typeof module[name] === "function")
        .sort();
}

function expectKitHoldsExports(kit: object, module: Record<string, unknown>): void {
    const entries = Object.entries(kit);
    expect(entries.map(([name]) => name).sort()).toEqual(functionExports(module));
    for (const [name, fn] of entries) {
        expect(fn, name).toBe(module[name]);
    }
}

describe("lite-gl backend family contract", () => {
    it("classifies every web export once and matches GLOps<WebGLFamily> exactly", () => {
        assertNone<Exclude<WebCallable, GLOpName | keyof Web.WebGLHostOps>>();
        assertNone<Exclude<GLOpName | keyof Web.WebGLHostOps, WebCallable>>();
        assertNone<GLOpName & keyof Web.WebGLHostOps>();
        assertNone<Mismatched<WebOps & Web.WebGLHostOps, typeof Web>>();
        expectKitHoldsExports(webUberKit, Web);
    });

    it("classifies every native export once and matches the GLOps<NativeGLFamily> subset exactly", () => {
        assertNone<Exclude<NativeCallable, GLOpName | keyof Native.NativeGLHostOps>>();
        assertNone<Exclude<keyof Native.NativeGLHostOps, NativeCallable>>();
        assertNone<GLOpName & keyof Native.NativeGLHostOps>();
        assertNone<Mismatched<NativeOps & Native.NativeGLHostOps, typeof Native>>();
        expectKitHoldsExports(nativeUberKit, Native);
    });

    it("accepts every portable value and keeps each backend's capabilities", () => {
        // `extends GLFamily` checks a family's slots only against the getter
        // bounds, so each backend must separately accept every value
        // backend-neutral code may write.
        assertNone<UnacceptedPortableValues<Web.WebGLFamily>>();
        assertNone<UnacceptedPortableValues<Native.NativeGLFamily>>();
        // Native draws are non-instanced and its samplers cannot be unbound,
        // while the web backend keeps both capabilities.
        assertTrue<Equal<Parameters<NativeOps["drawMesh"]>[1], 0 | undefined>>();
        assertTrue<Equal<Parameters<WebOps["drawMesh"]>[1], number | undefined>>();
        assertTrue<Equal<Parameters<NativeOps["setEffectTexture"]>[2], Native.GLTexture>>();
        assertTrue<Equal<Parameters<WebOps["setEffectTexture"]>[2], Web.GLTexture | null>>();
    });
});
