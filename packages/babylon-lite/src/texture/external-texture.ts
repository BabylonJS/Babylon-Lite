/** A caller-owned video source imported as a WebGPU external texture during rendering. */
export interface ExternalTexture {
    readonly video: HTMLVideoElement;
}

/** Wrap a caller-owned video for ShaderMaterial external-texture bindings. */
export function createExternalTexture(video: HTMLVideoElement): ExternalTexture {
    return { video };
}

/** Whether the wrapped video currently exposes frame data that WebGPU can import. */
export function isExternalTextureReady(texture: ExternalTexture): boolean {
    const video = texture.video;
    return video.readyState >= video.HAVE_CURRENT_DATA;
}
