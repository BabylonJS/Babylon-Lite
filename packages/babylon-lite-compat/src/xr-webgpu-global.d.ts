/**
 * Ambient draft WebXR/WebGPU binding declaration needed while type-checking the
 * Babylon Lite source-backed workspace package.
 */
declare const XRGPUBinding: {
    new (session: XRSession, device: GPUDevice): import("babylon-lite").XrGpuBinding;
};
