let _textureReferences: WeakMap<GPUTexture, number> | null = null;

/** @internal Shared lazy reference-count store for raw and facade texture owners. */
export function getTextureReferenceStore(): WeakMap<GPUTexture, number> {
    return (_textureReferences ??= new WeakMap());
}

/** @internal Read retained lifetime state without creating the lazy store. */
export function _getTextureReferenceCount(texture: GPUTexture): number | undefined {
    return _textureReferences?.get(texture);
}
