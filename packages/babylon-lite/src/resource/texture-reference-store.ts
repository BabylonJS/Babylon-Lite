let _textureReferences: WeakMap<GPUTexture, number> | null = null;

/** @internal Shared lazy reference-count store for raw and facade texture owners. */
export function getTextureReferenceStore(): WeakMap<GPUTexture, number> {
    return (_textureReferences ??= new WeakMap());
}
