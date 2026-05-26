/** Calculate full mip chain count for a given width/height. */
export function mipLevelCount(width: number, height: number): number {
    return Math.floor(Math.log2(Math.max(width, height))) + 1;
}

/** Calculate mip levels needed by transmission refraction, whose shader samples with a fixed LOD bias. */
export function biasedMipLevelCount(width: number, height: number, lodBias: number): number {
    const maxDim = Math.max(width, height);
    return Math.max(1, Math.floor(Math.log2(maxDim) - lodBias) + 1);
}
