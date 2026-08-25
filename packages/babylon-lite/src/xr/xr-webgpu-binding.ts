/**
 * Draft WebXR/WebGPU binding types
 * (https://github.com/immersive-web/WebXR-WebGPU-Binding).
 *
 * No browser ships `XRGPUBinding` yet and no `@types/*` package declares it, so
 * Babylon Lite owns these definitions. They are plain interfaces (pillar 4b) that
 * model exactly the subset of the binding the projection-layer renderer uses, plus
 * the constructor shape of the runtime global. They mirror the *shipped* WebGL
 * binding (`XRWebGLBinding` / `XRWebGLSubImage` in `@types/webxr`) so the code is
 * spec-faithful today and runs unchanged once a UA implements the binding.
 *
 * Unlike the ambient `@types/webxr` types (which the public `.d.ts` rollup treats
 * as a consumer-provided peer, like `@webgpu/types`), these have no package to
 * come from — so they are exported, self-contained interfaces that the rollup
 * inlines.
 */

/** Init dictionary for {@link XrGpuBinding.createProjectionLayer}. */
export interface XrGpuProjectionLayerInit {
    /** Color format of the layer's per-view textures. */
    colorFormat: GPUTextureFormat;
    /** Depth/stencil format handed to the compositor for reprojection, if any. */
    depthStencilFormat?: GPUTextureFormat;
    /** Extra texture-usage flags ORed into the layer's textures. */
    textureUsage?: GPUTextureUsageFlags;
    /** Render-resolution scale relative to {@link XrGpuBinding.nativeProjectionScaleFactor}. */
    scaleFactor?: number;
}

/**
 * A per-view sub-image of an XR layer: the WebGPU textures (and viewport) the app
 * renders one eye into for the current frame. Mirrors the draft `XRGPUSubImage`;
 * extends the shipped `XRSubImage` (which supplies `viewport`).
 */
export interface XrGpuSubImage extends XRSubImage {
    /** Color texture to render the view into. */
    readonly colorTexture: GPUTexture;
    /** Depth/stencil texture, or `null` when the layer has no depth attachment. */
    readonly depthStencilTexture: GPUTexture | null;
    /** Motion-vector texture for space-warp reprojection, when supported. */
    readonly motionVectorTexture: GPUTexture | null;
    /** Descriptor (array layer / aspect) for the per-view {@link GPUTextureView}. */
    getViewDescriptor(): GPUTextureViewDescriptor;
}

/**
 * The draft WebGPU XR binding: creates compositor layers backed by WebGPU textures
 * and hands out per-view sub-images each frame. Babylon Lite uses only the
 * projection-layer subset (stereo rendering); other layer kinds (quad, cylinder,
 * equirect, cube) are out of scope for this pass.
 */
export interface XrGpuBinding {
    /** Native (1.0-scale) projection-layer resolution factor reported by the device. */
    readonly nativeProjectionScaleFactor: number;
    /** Create a stereo projection layer whose views are rendered with WebGPU. */
    createProjectionLayer(init?: XrGpuProjectionLayerInit): XRProjectionLayer;
    /** WebGPU sub-image (textures + viewport) for `view` of `layer` this frame. */
    getViewSubImage(layer: XRProjectionLayer, view: XRView): XrGpuSubImage;
    /** Preferred swap-chain color format for this device/session. */
    getPreferredColorFormat(): GPUTextureFormat;
}

/**
 * Constructor shape of the global `XRGPUBinding`, present only on UAs that
 * implement the draft binding. Feature-detect with `isWebGpuXrSupported` before
 * constructing.
 */
export interface XrGpuBindingConstructor {
    readonly prototype: XrGpuBinding;
    new (session: XRSession, device: GPUDevice): XrGpuBinding;
}
